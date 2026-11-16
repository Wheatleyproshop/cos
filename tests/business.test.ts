import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setDatabaseHandle, systemDb, withTenant } from '@/db';
import { runMigrations } from '@/db/migrate';
import { organisations, payslips, staffProfiles, timeEntries, users, type Organisation } from '@/db/schema';
import { seedDemo } from '@/db/seed';
import { staffActor } from '@/lib/audit';
import { categorise, parseBankAmount, parseBankCsv, parseBankDate, ruleMatchFor } from '@/lib/bank-csv';
import { parseStockCsv } from '@/lib/stock-csv';
import type { Ctx } from '@/lib/services/common';

vi.mock('server-only', () => ({}));

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

describe('Shopify stock sync', () => {
  it('pulls variants page by page, refreshes the product list and records one count a day', async () => {
    const { vi } = await import('vitest');
    process.env.SHOPIFY_SHOP = 'test-shop';
    process.env.SHOPIFY_CLIENT_ID = 'id';
    process.env.SHOPIFY_CLIENT_SECRET = 'secret';
    const v = (handle: string, title: string, vendor: string, type: string, opts: string[], qty: number, cost: string | null, price: string) => ({
      sku: `${handle}-${opts.join('-')}`, price, inventoryQuantity: qty, selectedOptions: opts.map((value) => ({ value })),
      inventoryItem: { tracked: true, unitCost: cost ? { amount: cost } : null }, product: { handle, title, vendor, productType: type, category: null },
    });
    const pages = [
      { nodes: [v('gt3-driver', 'GT3 Driver', 'Titleist', 'Drivers', ['9'], 2, '340.00', '549.00'), v('tour-polo', 'Tour Polo', 'NIKE', 'Polo', ['M', 'Navy'], 6, '20.00', '45.00')], next: 'c1' },
      { nodes: [v('tour-polo', 'Tour Polo', 'NIKE', 'Polo', ['L', 'Navy'], 0, '20.00', '45.00'), v('mystery-hat', 'Mystery Hat', 'Desirable Golf', '', ['Default Title'], 3, null, '20.00')], next: null },
    ];
    const calls: string[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith('/admin/oauth/access_token')) {
        expect(String(init?.body)).toContain('grant_type=client_credentials');
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 86399, scope: 'read_products,read_inventory' }));
      }
      expect((init?.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('tok');
      const cursor = JSON.parse(String(init?.body)).variables.cursor;
      const p = pages[cursor ? 1 : 0];
      return new Response(JSON.stringify({ data: { productVariants: { pageInfo: { hasNextPage: Boolean(p.next), endCursor: p.next }, nodes: p.nodes } } }));
    });
    try {
      const { syncShopifyStock, shopifyStatus } = await import('@/lib/services/business/shopify-sync');
      const r = await syncShopifyStock();
      expect(r).toEqual({ variants: 4, lines: 3, units: 11, noCost: 1 });
      expect(calls.filter((c) => c.includes('graphql.json'))).toHaveLength(2);
      // Running again the same day replaces today's count rather than adding another.
      await syncShopifyStock();
      const { stockReport } = await import('@/lib/services/business/stock');
      const rep = await stockReport(org.id);
      expect(rep.snaps.filter((s) => s.fileName === 'Shopify (automatic)')).toHaveLength(1);
      expect(rep.latest).toMatchObject({ units: 11, costPence: 2 * 34000 + 6 * 2000 });
      expect(rep.latest!.byBrand.map((b) => b.name)).toEqual(['Titleist', 'Nike', 'Desirable Golf']);
      expect(rep.latest!.byCategory.map((c) => c.name)).toEqual(expect.arrayContaining(['Drivers', 'Clothing', 'Headwear']));
      expect((await shopifyStatus(org.id)).connected).toBe(true);
    } finally {
      fetchMock.mockRestore();
      delete process.env.SHOPIFY_SHOP;
      delete process.env.SHOPIFY_CLIENT_ID;
      delete process.env.SHOPIFY_CLIENT_SECRET;
    }
  });
});

describe('brand review from Shopify sales, with credit vouchers', () => {
  it('imports sales lines, and counts credit vouchers as money received rather than a discount', async () => {
    const { importBulkFile } = await import('@/lib/services/business/shopify-sales');
    const { brandReview, setVoucherDiscount } = await import('@/lib/services/business/brand-review');
    const order = (id: string, name: string, src: string) => JSON.stringify({ id: `gid://shopify/Order/${id}`, name, processedAt: '2026-11-10T11:00:00Z', sourceName: src, cancelledAt: null, test: false });
    const line = (id: string, parent: string, o: Record<string, unknown>) => JSON.stringify({ id: `gid://shopify/LineItem/${id}`, __parentId: `gid://shopify/Order/${parent}`, ...o });
    const disc = (name: string, amount: string) => ({ allocatedAmountSet: { shopMoney: { amount } }, discountApplication: { __typename: 'DiscountCodeApplication', code: name } });
    const jsonl = [
      order('1', '#1001', 'pos'),
      // GT3 Driver £549 (cost £340): £100 of CreditYard credit taken at the till.
      line('11', '1', { sku: 'gt3-driver-9', vendor: 'Titleist', quantity: 1, currentQuantity: 1, originalUnitPriceSet: { shopMoney: { amount: '549.00' } }, variant: { selectedOptions: [{ value: '9' }] }, product: { handle: 'gt3-driver', productType: 'Drivers', title: 'GT3 Driver', category: null }, discountAllocations: [disc('CREDITYARD', '100.00')] }),
      order('2', '#1002', 'web'),
      // Two polos at £45 (cost £20), one refunded, with a real 10% discount.
      line('21', '2', { sku: 'tour-polo-M-Navy', vendor: 'NIKE', quantity: 2, currentQuantity: 1, originalUnitPriceSet: { shopMoney: { amount: '45.00' } }, variant: { selectedOptions: [{ value: 'M' }, { value: 'Navy' }] }, product: { handle: 'tour-polo', productType: 'Polo', title: 'Tour Polo', category: null }, discountAllocations: [disc('SAVE10', '9.00')] }),
    ].join('\n');
    expect(await importBulkFile(org, jsonl, 'Europe/London')).toEqual({ orders: 2, lines: 2 });

    const before = await brandReview(org.id, '2026-11-01', '2026-11-16');
    const tit = before.brands.find((b) => b.name === 'Titleist')!;
    expect(tit.units).toBe(1);
    expect(tit.salesPence).toBe(44900); // the voucher still counts as a discount until it's marked
    expect(before.discounts.map((d) => d.name)).toEqual(['CREDITYARD', 'SAVE10']);

    await setVoucherDiscount(owner, 'CREDITYARD', true);
    const after = await brandReview(org.id, '2026-11-01', '2026-11-16');
    const t2 = after.brands.find((b) => b.name === 'Titleist')!;
    expect(t2.salesPence).toBe(54900);
    expect(t2.voucherPence).toBe(10000);
    // Margin on price less VAT: 549/1.2 = 457.50 vs cost 340 → 26%; it would look like 449/1.2 = 374.17 → 9%.
    expect(t2.marginPct).toBe(26);
    expect(t2.reportedMarginPct).toBe(9);
    const nike = after.brands.find((b) => b.name === 'Nike')!;
    expect(nike).toMatchObject({ units: 1, salesPence: 4500 - 450, discountPence: 450 });
    expect(after.discounts.find((d) => d.name === 'CREDITYARD')!.voucher).toBe(true);
    const { salesLines } = await import('@/lib/services/business/brand-review');
    const [driver] = await salesLines(org.id, '2026-11-01', '2026-11-16', { brand: 'Titleist' });
    expect(driver).toMatchObject({ fullPence: 54900, discountPence: 0, creditPence: 10000, soldForPence: 54900, paidOtherwisePence: 44900, marginPct: 26 });
    const [polo] = await salesLines(org.id, '2026-11-01', '2026-11-16', { brand: 'Nike' });
    expect(polo).toMatchObject({ fullPence: 4500, discountPence: 450, creditPence: 0, soldForPence: 4050, discountNames: ['SAVE10'] });
  });
});

describe('Connect to Shopify (one-time approval)', () => {
  it('only accepts a callback signed by Shopify with the app secret', async () => {
    const { createHmac } = await import('node:crypto');
    process.env.SHOPIFY_SHOP = 'test-shop';
    process.env.SHOPIFY_CLIENT_ID = 'id';
    process.env.SHOPIFY_CLIENT_SECRET = 'secret';
    try {
      const { verifyShopifyHmac, shopifyAuthorizeUrl } = await import('@/lib/shopify');
      const base = 'code=abc&shop=test-shop.myshopify.com&state=xyz&timestamp=1794770000';
      const good = createHmac('sha256', 'secret').update(base).digest('hex');
      expect(verifyShopifyHmac(new URLSearchParams(`${base}&hmac=${good}`))).toBe(true);
      expect(verifyShopifyHmac(new URLSearchParams(`${base.replace('abc', 'abd')}&hmac=${good}`))).toBe(false);
      expect(verifyShopifyHmac(new URLSearchParams(base))).toBe(false);
      // Real callbacks include a base64 "host" with '=' padding: Shopify signs the re-encoded query string.
      const withHost = new URLSearchParams([['code', 'abc'], ['host', 'YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvdGVzdA=='], ['shop', 'test-shop.myshopify.com'], ['state', 'x-y_z'], ['timestamp', '1794770000']]);
      const signed = createHmac('sha256', 'secret').update(withHost.toString()).digest('hex');
      withHost.append('hmac', signed);
      expect(verifyShopifyHmac(new URLSearchParams(withHost.toString()))).toBe(true);
      const u = new URL(shopifyAuthorizeUrl('xyz', 'https://cos.example/api/shopify/callback'));
      expect(u.host).toBe('test-shop.myshopify.com');
      expect(u.searchParams.get('scope')).toBe('read_products,read_inventory,read_orders');
    } finally {
      delete process.env.SHOPIFY_SHOP;
      delete process.env.SHOPIFY_CLIENT_ID;
      delete process.env.SHOPIFY_CLIENT_SECRET;
    }
  });
});

describe('advice: stock checks and why margins are what they are', () => {
  it('lists stock to check, and explains margins with vouchers kept out of discounts', async () => {
    const { stockChecks, marginStory } = await import('@/lib/services/business/advice');
    const c = (await stockChecks(org.id, '2026-11-01', '2026-11-16'))!;
    expect(c.noCost.map((i) => i.title)).toContain('Mystery Hat');
    expect(c.negative).toEqual([]);
    const story = await marginStory(org.id, '2026-11-01', '2026-11-16');
    const tit = story.find((m) => m.name === 'Titleist')!;
    // GT3 Driver: £549 (£457.50 less VAT), cost £340 → 26% at full price; the £100 CreditYard credit is money, not a discount.
    expect(tit).toMatchObject({ fullMargin: 26, afterDiscounts: 26, ifVoucherCounted: 9, voucherPence: 10000, realPence: 0 });
    expect(tit.reasons.join(' ')).toMatch(/credit vouchers/);
    expect(tit.reasons.join(' ')).toMatch(/only makes 26%/);
  });
});

describe('tax planner', () => {
  it('works out VAT quarters, due dates and corporation tax bands', async () => {
    const { vatQuarter, accountingYear, corporationTax, vatForecast, corporationTaxForecast, financeSettings } = await import('@/lib/services/business/tax');
    // Stagger 1 (Mar/Jun/Sep/Dec): 15 Nov 2026 is in Oct–Dec, due 7 Feb.
    expect(vatQuarter('2026-11-15', 1)).toMatchObject({ start: '2026-10-01', end: '2027-01-01', due: '2027-02-07' });
    expect(vatQuarter('2026-11-15', 1, -1)).toMatchObject({ start: '2026-07-01', end: '2026-10-01', due: '2026-11-07' });
    // Stagger 2 (Apr/Jul/Oct/Jan): Nov–Jan.
    expect(vatQuarter('2026-11-15', 2)).toMatchObject({ start: '2026-11-01', end: '2027-02-01', due: '2027-03-07' });
    // Stagger 3 (May/Aug/Nov/Feb): Sep–Nov, due 7 Jan.
    expect(vatQuarter('2026-11-15', 3)).toMatchObject({ start: '2026-09-01', end: '2026-12-01', due: '2027-01-07' });
    // Year ending 31 March: due 1 January (9 months and a day later).
    expect(accountingYear('2026-11-15', 3)).toMatchObject({ start: '2026-04-01', end: '2027-04-01', due: '2028-01-01' });
    expect(accountingYear('2026-11-15', 12)).toMatchObject({ start: '2026-01-01', end: '2027-01-01', due: '2027-10-01' });
    // 19% up to £50k, 25% over £250k, marginal relief between (£100k → £22,750).
    expect(corporationTax(40_000_00)).toBe(7_600_00);
    expect(corporationTax(100_000_00)).toBe(22_750_00);
    expect(corporationTax(300_000_00)).toBe(75_000_00);
    expect(corporationTax(-5)).toBe(0);
    // Forecasts run on the data from the earlier tests without errors, and are sensible.
    const fin = financeSettings({});
    const v = await vatForecast(org.id, fin, '2026-11-15');
    expect(v.quarters).toHaveLength(3);
    expect(v.quarters.find((q) => q.current)!.outputVat).toBeGreaterThan(0);
    const ct = await corporationTaxForecast(org.id, fin, '2026-11-15');
    expect(ct.due).toBe('2027-10-01');
    expect(ct.salesExVat).toBeGreaterThan(0);
  });

  it('gives the owner one ranked list of advice', async () => {
    const { businessAdvice } = await import('@/lib/services/business/adviser');
    const [o] = await systemDb().select().from(organisations).where(eq(organisations.id, org.id));
    const a = await businessAdvice(o);
    expect(a.advice.length).toBeGreaterThan(0);
    expect(a.advice.map((x) => x.priority)).toEqual([...a.advice.map((x) => x.priority)].sort());
    expect(a.advice.some((x) => x.area === 'Cash & tax')).toBe(true);
  });
});

describe('previous years and year at a glance', () => {
  it('reads Shopify sales reports (monthly totals, and by vendor with or without dates)', async () => {
    const { parseSalesHistory, monthOf } = await import('@/lib/sales-history-csv');
    expect(monthOf('2025-03-01')).toBe('2025-03-01');
    expect(monthOf('Mar 2025')).toBe('2025-03-01');
    expect(monthOf('15/03/2025')).toBe('2025-03-01');
    const monthly = parseSalesHistory('Month,Orders,Gross sales,Discounts,Returns,Net sales,Shipping charges,Taxes,Total sales\n2025-10-01,120,"£20,000.00",-£1000.00,-£500.00,"£18,500.00",£50.00,"£3,700.00","£22,250.00"\n2025-11-01,90,£15000,-£800,£0,£14200,£0,£2840,£17040\n,Total,,,,,,,\n');
    expect(monthly).toEqual([
      { month: '2025-10-01', months: 1, dimension: 'total', name: '', salesPence: 2_220_000, discountPence: 100_000, quantity: 0, orders: 120 },
      { month: '2025-11-01', months: 1, dimension: 'total', name: '', salesPence: 1_704_000, discountPence: 80_000, quantity: 0, orders: 90 },
    ]);
    const vendor = parseSalesHistory('Product vendor,Net quantity,Net sales,Taxes,Total sales\nNIKE,40,£2000,£400,£2400\nTitleist,10,£1000,£200,£1200\n', { year: 2025 });
    expect(vendor.map((v) => [v.name, v.month, v.months, v.salesPence, v.quantity])).toEqual([['Nike', '2025-01-01', 12, 240_000, 40], ['Titleist', '2025-01-01', 12, 120_000, 10]]);
    expect(() => parseSalesHistory('Product vendor,Net sales\nNike,10\n')).toThrow(/which year/);
  });

  it('puts each month beside the same month last year', async () => {
    const { importSalesHistory, yearAtAGlance } = await import('@/lib/services/business/year');
    const { financeSettings } = await import('@/lib/services/business/tax');
    const f = (body: string) => new File([body], 'sales-2025.csv', { type: 'text/csv' });
    expect(await importSalesHistory(owner, f('Month,Net sales,Taxes\n2025-11-01,£1000,£200\n'))).toMatchObject({ rows: 1, dimension: 'total' });
    const y = await yearAtAGlance(org.id, financeSettings({}), '2026-11-15');
    const nov = y.months.find((m) => m.month === '2026-11-01')!;
    expect(nov.sales.prev).toBe(120_000);
    expect(nov.sales.now).toBeGreaterThan(0); // live Shopify sales from earlier tests
    expect(nov.moneyIn.now).toBe(120_000); // bank statement uploaded earlier: £1,000 + £200 in November
    expect(y.months).toHaveLength(12);
    expect(y.months[0].month).toBe('2026-01-01');
  });
});

describe('spend with suppliers vs what sold', () => {
  it('lines up supplier payments with the same weeks of sales', async () => {
    const { supplierReturn } = await import('@/lib/services/business/advice');
    const { uploadBankStatement } = await import('@/lib/services/business/bank');
    // £1,200 paid to Acushnet (Titleist & FootJoy) in the same weeks as the GT3 Driver sale.
    await uploadBankStatement(owner, new File(['Date,Description,Amount\n12/11/2026,ACUSHNET EUROPE LTD,-1200.00\n'], 'acushnet.csv', { type: 'text/csv' }), 'Current');
    const r = (await supplierReturn(org.id, '2026-11-15'))!;
    const a = r.rows.find((x) => x.name === 'Titleist & FootJoy')!;
    expect(a.paid).toBe(120_000);
    expect(a.sales).toBeGreaterThanOrEqual(54_900);
    expect(a.note).toMatch(/buying|selling|paid/);
  });
});

describe('compare bank periods', () => {
  it('lists the months and years with statements, and compares two periods by category', async () => {
    const { bankPeriods, compareBank } = await import('@/lib/services/business/bank');
    const p = await bankPeriods(org.id);
    expect(p.months[0]).toBe('2026-11');
    expect(p.years).toContain('2026');
    const c = await compareBank(org.id, { from: '2026-11-01', to: '2026-12-01' }, { from: '2026-10-01', to: '2026-11-01' });
    expect(c.a.in).toBeGreaterThan(0);
    expect(c.bHasData).toBe(false);
    expect(c.rows.some((r) => r.category === 'Card & online takings' && r.aIn > 0)).toBe(true);
  });
});

describe('Business area: owner only', () => {
  it('is visible only to the owner who set the passcode — not other admins, staff or the shop login', async () => {
    const { canSeeBusiness } = await import('@/lib/business-lock');
    const base = { org: { ...org, businessOwnerId: null, businessPasscodeHash: null } };
    expect(canSeeBusiness({ ...base, id: 'a', role: 'admin', sharedLoginName: null })).toBe(true); // before anyone has claimed it
    expect(canSeeBusiness({ ...base, id: 'a', role: 'manager', sharedLoginName: null })).toBe(false);
    expect(canSeeBusiness({ ...base, id: 'a', role: 'admin', sharedLoginName: 'Pro Shop' })).toBe(false);
    const owned = { org: { ...org, businessOwnerId: 'a', businessPasscodeHash: 'x' } };
    expect(canSeeBusiness({ ...owned, id: 'a', role: 'admin', sharedLoginName: null })).toBe(true);
    expect(canSeeBusiness({ ...owned, id: 'b', role: 'admin', sharedLoginName: null })).toBe(false); // another admin
  });
});
