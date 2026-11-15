import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setDatabaseHandle, systemDb, withTenant } from '@/db';
import { runMigrations } from '@/db/migrate';
import { organisations, payslips, staffProfiles, timeEntries, users, type Organisation } from '@/db/schema';
import { seedDemo } from '@/db/seed';
import { staffActor } from '@/lib/audit';
import { categorise, parseBankAmount, parseBankCsv, parseBankDate, ruleMatchFor } from '@/lib/bank-csv';
import { parseStockCsv } from '@/lib/stock-csv';
import type { Ctx } from '@/lib/services/common';

let close: () => Promise<void>;
let org: Organisation;
let other: Organisation;
let owner: Ctx;
let willId: string;

beforeAll(async () => {
  const h = await runMigrations('pglite:memory://', { keepOpen: true });
  setDatabaseHandle(h);
  close = h.close;
  await seedDemo(h.db);
  const db = systemDb();
  [org] = await db.select().from(organisations).where(eq(organisations.slug, 'desirable-golf'));
  [other] = await db.select().from(organisations).where(eq(organisations.slug, 'fairway-demo'));
  const [aaron] = await db.select().from(users).where(eq(users.email, 'aaron@desirablegolf.test'));
  const [will] = await db.select().from(users).where(eq(users.email, 'will@desirablegolf.test'));
  owner = { org, actor: staffActor(aaron), userId: aaron.id, role: 'admin' };
  willId = will.id;
});

afterAll(async () => close?.());

describe('bank statement CSVs', () => {
  it('reads dates and amounts the way UK banks write them', () => {
    expect(parseBankDate('14/11/2026')).toBe('2026-11-14');
    expect(parseBankDate('3/2/26')).toBe('2026-02-03');
    expect(parseBankDate('14 Nov 2026')).toBe('2026-11-14');
    expect(parseBankDate('2026-11-14T10:00:00')).toBe('2026-11-14');
    expect(parseBankDate('Total')).toBeNull();
    expect(parseBankAmount('£1,234.50')).toBe(123450);
    expect(parseBankAmount('-45.00')).toBe(-4500);
    expect(parseBankAmount('(12.99)')).toBe(-1299);
    expect(parseBankAmount('20.00 DR')).toBe(-2000);
    expect(parseBankAmount('')).toBeNull();
  });

  it('handles a single Amount column, and separate Paid in / Paid out columns', () => {
    const lloyds = parseBankCsv(
      'Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance\n' +
        '14/11/2026,DEB,12-34-56,12345678,ACUSHNET EUROPE LTD,850.00,,4150.00\n' +
        '14/11/2026,BGC,12-34-56,12345678,SUMUP PAYMENTS,,1200.00,5000.00\n',
    );
    expect(lloyds.map((t) => [t.date, t.amountPence])).toEqual([
      ['2026-11-14', -85000],
      ['2026-11-14', 120000],
    ]);
    expect(lloyds[0].description).toContain('ACUSHNET EUROPE LTD');
    // Account details above the header row, a signed amount column, and a totals line at the end.
    const starling = parseBankCsv('Account: Business\n\nDate,Counter Party,Reference,Type,Amount (GBP),Balance (GBP)\n01/11/2026,HMRC VAT,VAT Q3,PAYMENT,-2400.00,100.00\n,,,Total,-2400.00,\n');
    expect(starling).toHaveLength(1);
    expect(starling[0]).toMatchObject({ date: '2026-11-01', amountPence: -240000, balancePence: 10000 });
    expect(() => parseBankCsv('Name,Value\nx,1')).toThrow(/Date column/);
  });

  it('sorts transactions into sensible categories, and learns', () => {
    expect(categorise('SUMUP PAYMENTS LTD', 120000)).toBe('Card & online takings');
    expect(categorise('ACUSHNET EUROPE LTD', -85000)).toBe('Stock & suppliers');
    expect(categorise('HMRC VAT', -240000)).toBe('HMRC (VAT, PAYE)');
    expect(categorise('BRITISH GAS', -9000)).toBe('Utilities');
    expect(categorise('SOMETHING NEW', -500)).toBe('Other spending');
    expect(categorise('WHEATLEY GC', -150000, [{ match: 'wheatley gc', category: 'Rent & rates' }])).toBe('Rent & rates');
    expect(ruleMatchFor('CARD 1234 TESCO STORES 3021 14/11/26')).toBe('TESCO STORES');
  });

  it('uploads, skips duplicates, summarises and re-categorises', async () => {
    const { uploadBankStatement, bankSummary, listTransactions, setCategory } = await import('@/lib/services/business/bank');
    const csv = 'Date,Description,Amount,Balance\n02/11/2026,SUMUP PAYMENTS,1000.00,1000.00\n03/11/2026,WHEATLEY GC RENT,-400.00,600.00\n04/11/2026,MYSTERY LTD,-50.00,550.00\n';
    const file = (name: string, body: string) => new File([body], name, { type: 'text/csv' });
    const first = await uploadBankStatement(owner, file('nov.csv', csv), 'Current');
    expect(first).toMatchObject({ added: 3, duplicates: 0 });
    const again = await uploadBankStatement(owner, file('nov-again.csv', csv + '05/11/2026,SUMUP PAYMENTS,200.00,750.00\n'), 'Current');
    expect(again).toMatchObject({ added: 1, duplicates: 3 });
    const sum = await bankSummary(org.id, '2026-11-01', '2026-12-01');
    expect(sum.months).toEqual([{ month: '2026-11', inPence: 120000, outPence: 45000 }]);
    const txs = await listTransactions(org.id, { from: '2026-11-01', to: '2026-12-01', q: 'mystery' });
    expect(txs).toHaveLength(1);
    expect(await setCategory(owner, txs[0].t.id, 'Insurance', true)).toBe(1);
    const [after] = await listTransactions(org.id, { from: '2026-11-01', to: '2026-12-01', category: 'Insurance' });
    expect(after.t.description).toBe('MYSTERY LTD');
    // Another shop never sees these.
    expect(await bankSummary(other.id, '2026-11-01', '2026-12-01')).toEqual({ months: [], categories: [] });
  });
});

describe('staff records', () => {
  it('encrypts private details, and only reveals them when asked (and records that)', async () => {
    const { saveStaffRecord, getStaffRecord } = await import('@/lib/services/business/staff');
    await saveStaffRecord(
      owner, willId,
      { jobTitle: 'Shop assistant', payType: 'hourly', hourlyRatePence: '12.50', contractedMinutesPerWeek: '20', holidayTenthsPerYear: '28', niNumber: 'qq 12 34 56 c', sortCode: '123456', accountNumber: '12345678' },
      { includeSensitive: true },
    );
    const [row] = await withTenant(org.id, (tx) => tx.select().from(staffProfiles).where(eq(staffProfiles.userId, willId)));
    expect(row.hourlyRatePence).toBe(1250);
    expect(row.contractedMinutesPerWeek).toBe(1200);
    expect(row.sensitiveEncrypted).toBeTruthy();
    expect(row.sensitiveEncrypted).not.toContain('QQ123456C');
    const hidden = await getStaffRecord(owner, willId);
    expect(hidden.sensitive).toBeNull();
    const shown = await getStaffRecord(owner, willId, { reveal: true });
    expect(shown.sensitive).toMatchObject({ niNumber: 'QQ123456C', sortCode: '12-34-56', accountNumber: '12345678' });
    // Saving the everyday fields without the private ones keeps them.
    await saveStaffRecord(owner, willId, { jobTitle: 'Senior assistant', payType: 'hourly', hourlyRatePence: '13.00' }, { includeSensitive: false });
    expect((await getStaffRecord(owner, willId, { reveal: true })).sensitive?.niNumber).toBe('QQ123456C');
    await expect(saveStaffRecord(owner, willId, { niNumber: 'nope', payType: 'hourly' }, { includeSensitive: true })).rejects.toMatchObject({ fieldErrors: { niNumber: expect.any(String) } });
  });
});

describe('time clock and payroll', () => {
  it('clocks in and out with a PIN, and locks out after repeated wrong PINs', async () => {
    const { setClockPin, clockToggle, clockBoard } = await import('@/lib/services/business/staff');
    await expect(setClockPin(owner, willId, '1111')).rejects.toThrow(/harder to guess/);
    await setClockPin(owner, willId, '4826');
    const device = staffActor({ id: owner.userId!, name: 'Pro Shop (clock screen)' });
    expect((await clockToggle(org.id, willId, '4826', device)).action).toBe('in');
    expect((await clockBoard(org.id)).find((p) => p.id === willId)?.inSince).toBeTruthy();
    expect((await clockToggle(org.id, willId, '4826', device)).action).toBe('out');
    for (let i = 0; i < 5; i++) await expect(clockToggle(org.id, willId, '0000', device)).rejects.toThrow(/PIN isn’t right/);
    await expect(clockToggle(org.id, willId, '4826', device)).rejects.toThrow(/Too many wrong PINs/);
  });

  it('works out pay from hours × rate; deductions give net pay; finalised runs are locked', async () => {
    const { addTimeEntry } = await import('@/lib/services/business/time');
    const { createPayRun, getPayRun, updatePayslip, finalisePayRun, netPence, payRunCsv } = await import('@/lib/services/business/payroll');
    // Two shifts: 09:00–17:30 with a 30 minute break (8h), and 10:00–14:00 (4h). Rate £13.00.
    await addTimeEntry(owner, { userId: willId, date: '2026-10-05', start: '09:00', end: '17:30', breakMinutes: '30', note: '' });
    await addTimeEntry(owner, { userId: willId, date: '2026-10-06', start: '10:00', end: '14:00', breakMinutes: '0', note: '' });
    await expect(addTimeEntry(owner, { userId: willId, date: '2026-10-07', start: '09:00', end: '', breakMinutes: '500', note: '' })).rejects.toMatchObject({ fieldErrors: { breakMinutes: expect.any(String) } });
    const run = await createPayRun(owner, { periodStart: '2026-10-01', periodEnd: '2026-10-31', payDate: '2026-10-31' });
    const data = (await getPayRun(org.id, run.id))!;
    const will = data.slips.find((x) => x.s.userId === willId)!.s;
    expect(will.minutesWorked).toBe(12 * 60);
    expect(will.basicPence).toBe(12 * 1300);
    await updatePayslip(owner, will.id, { basicPence: '156.00', taxPence: '0', employeeNiPence: '0', pensionPence: '4.68', bonusPence: '20' });
    const [saved] = await withTenant(org.id, (tx) => tx.select().from(payslips).where(eq(payslips.id, will.id)));
    expect(netPence(saved)).toBe(15600 + 2000 - 468);
    expect(payRunCsv((await getPayRun(org.id, run.id))!)).toContain('171.32');
    await finalisePayRun(owner, run.id);
    await expect(updatePayslip(owner, will.id, { basicPence: '1' })).rejects.toThrow(/finalised/);
  });

  it('keeps every correction to hours on the history', async () => {
    const { updateTimeEntry, removeTimeEntry } = await import('@/lib/services/business/time');
    const [e] = await withTenant(org.id, (tx) => tx.select().from(timeEntries).where(eq(timeEntries.userId, willId)).limit(1));
    await updateTimeEntry(owner, e.id, { date: '2026-10-05', start: '08:30', end: '17:30', breakMinutes: '30', note: 'Started early' });
    await removeTimeEntry(owner, e.id);
    const { auditEvents } = await import('@/db/schema');
    const evs = await withTenant(org.id, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.entityId, willId)));
    const types = evs.map((x) => x.eventType);
    expect(types).toEqual(expect.arrayContaining(['time_entry_added', 'time_entry_changed', 'time_entry_removed', 'clocked_in', 'clocked_out', 'staff_sensitive_viewed']));
    const change = evs.find((x) => x.eventType === 'time_entry_changed')!;
    expect((change.oldValueJson as { clockIn: string }).clockIn).not.toBe((change.newValueJson as { clockIn: string }).clockIn);
  });
});

describe('stock and commitments', () => {
  const productExport =
    'Handle,Title,Vendor,Product Category,Type,Option1 Name,Option1 Value,Option2 Name,Option2 Value,Option3 Name,Option3 Value,Variant SKU,Variant Price,Cost per item,Status\n' +
    'victory-polo,Victory Polo,NIKE,Apparel > Shirts,Nike,Size,M,Colour,Navy,,,NK-VP-M-NV,45.00,22.50,active\n' +
    'victory-polo,,,,,,L,,Navy,,,NK-VP-L-NV,45.00,22.50,\n' +
    'pro-v1,Pro V1 Golf Balls,Titleist,,Golf Balls,Title,Default Title,,,,,TIT-PV1,54.99,32.00,active\n';
  const inventoryOld =
    'Handle,Title,Option1 Name,Option1 Value,Option2 Name,Option2 Value,Option3 Name,Option3 Value,SKU,HS Code,COO,Desirable Golf,Orders\n' +
    'victory-polo,Victory Polo,Size,M,Colour,Navy,,,NK-VP-M-NV,,,3,not stocked\n' +
    'victory-polo,Victory Polo,Size,L,Colour,Navy,,,NK-VP-L-NV,,,2,0\n' +
    'pro-v1,Pro V1 Golf Balls,Title,Default Title,,,,,TIT-PV1,,,10,0\n' +
    'mystery,Mystery,Title,Default Title,,,,,ZZZ,,,1,0\n';
  const inventoryNew =
    'Handle,Title,Option1 Name,Option1 Value,Option2 Name,Option2 Value,Option3 Name,Option3 Value,SKU,Location,Incoming (not editable),Committed (not editable),Available (not editable),On hand (current),On hand (new)\n' +
    'pro-v1,Pro V1 Golf Balls,Title,Default Title,,,,,TIT-PV1,Desirable Golf,0,0,6,6,\n';

  it('reads Shopify product and inventory exports (old and new layouts)', () => {
    const p = parseStockCsv(productExport);
    expect(p.kind).toBe('catalogue');
    if (p.kind !== 'catalogue') return;
    expect(p.rows).toHaveLength(3);
    expect(p.rows[0]).toMatchObject({ key: 'victory-polo|m|navy', brand: 'Nike', category: 'Clothing', costPence: 2250, pricePence: 4500 });
    expect(p.rows[1]).toMatchObject({ key: 'victory-polo|l|navy', title: 'Victory Polo', brand: 'Nike' });
    expect(p.rows[2]).toMatchObject({ key: 'pro-v1', category: 'Golf balls' });
    const q = parseStockCsv(inventoryOld);
    expect(q.kind === 'quantities' && q.rows.map((r) => [r.key, r.quantity])).toEqual([['victory-polo|m|navy', 3], ['victory-polo|l|navy', 2], ['pro-v1', 10], ['mystery', 1]]);
    const n = parseStockCsv(inventoryNew);
    expect(n.kind === 'quantities' && n.rows[0]).toMatchObject({ key: 'pro-v1', quantity: 6 });
  });

  it('values stock by brand and category, and totals what is committed', async () => {
    const { importStockFile, stockReport, commitments } = await import('@/lib/services/business/stock');
    const f = (name: string, body: string) => new File([body], name, { type: 'text/csv' });
    expect(await importStockFile(owner, f('products.csv', productExport), '2026-11-15')).toMatchObject({ kind: 'catalogue', rows: 3, withCost: 3 });
    expect(await importStockFile(owner, f('inventory.csv', inventoryOld), '2026-11-15')).toMatchObject({ kind: 'stock', lines: 4, unmatched: 1, units: 16 });
    const r = await stockReport(org.id);
    expect(r.latest).toMatchObject({ units: 16, costPence: 5 * 2250 + 10 * 3200, retailPence: 5 * 4500 + 10 * 5499, noCost: 1 });
    expect(r.latest!.byBrand.map((b) => [b.name, b.costPence])).toEqual([['Titleist', 32000], ['Nike', 11250], ['Unknown', 0]]);
    expect(r.latest!.byCategory[0]).toMatchObject({ name: 'Golf balls', units: 10 });
    const c = await commitments(org.id);
    expect(c.prebookCostPence).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(c.byMonth)).toBe(true);
    expect(c.customerOrders.byBrand.length).toBeGreaterThan(0);
  });

  it('gives plain-English feedback on spending', async () => {
    const { spendingInsights, supplierFor } = await import('@/lib/services/business/insights');
    expect(supplierFor('ACUSHNET EUROPE LTD DD')).toBe('Titleist & FootJoy');
    expect(supplierFor('TESCO')).toBeNull();
    const r = await spendingInsights(org.id, '2026-11-01', '2026-12-01', 1);
    expect(r.insights.length).toBeGreaterThan(0);
    expect(r.insights[0].title).toMatch(/more came in than went out/);
  });
});
