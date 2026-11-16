import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setDatabaseHandle, systemDb, withTenant } from '@/db';
import { runMigrations } from '@/db/migrate';
import { messages, orders, organisations, users, type Organisation } from '@/db/schema';
import { seedDemo } from '@/db/seed';
import { staffActor } from '@/lib/audit';
import type { Ctx } from '@/lib/services/common';
import { createTeamOrder, parseSizes, setTeamOrderClosed, submitTeamOrder, teamCsv, teamOrderDetail, updateTeamOrder } from '@/lib/services/team-orders';

vi.mock('server-only', () => ({}));

let close: () => Promise<void>;
let org: Organisation;
let staff: Ctx;
let manager: Ctx;

beforeAll(async () => {
  const h = await runMigrations('pglite:memory://', { keepOpen: true });
  setDatabaseHandle(h);
  close = h.close;
  await seedDemo(h.db);
  const db = systemDb();
  [org] = await db.select().from(organisations).where(eq(organisations.slug, 'desirable-golf'));
  const [will] = await db.select().from(users).where(eq(users.email, 'will@desirablegolf.test'));
  staff = { org, actor: staffActor(will), userId: will.id, role: 'staff' };
  const [aaron] = await db.select().from(users).where(eq(users.email, 'aaron@desirablegolf.test'));
  manager = { org, actor: staffActor(aaron), userId: aaron.id, role: 'admin' };
});

afterAll(async () => close?.());

const setup = {
  title: 'Ladies team kit', teamName: 'Wheatley Ladies', brand: 'Glenmuir', namePrice: '5', namePlacement: 'Right chest', nameMaxLength: '20', terms: '', closesOn: '',
  description: 'All prices include the club crest on the left chest.',
  item0_product: 'Arwen polo', item0_colour: 'Berry', item0_price: '49.99', item0_sizes: '8, 10, 12, 12, 14',
  item1_product: 'Ava 1/4 zip', item1_price: '59.99', item1_sizes: '8, 10, 12, 14',
  item2_product: 'Asha sweater', item2_price: '74.99', item2_sizes: '8, 10, 12, 14',
  item3_product: '', item3_price: '', item3_sizes: '8, 10',
};
const member = (o: Record<string, string> = {}) => ({
  customerName: 'Sarah Jones', email: `m-${Math.random().toString(36).slice(2)}@example.com`, phone: '', accept: 'yes', ...o,
});
const make = (o: Record<string, string> = {}) => createTeamOrder(manager, { ...setup, ...o }, []);

describe('team order links', () => {
  it('parses sizes, de-duplicated', () => {
    expect(parseSizes('8, 10,\n12, 12 , ,14')).toEqual(['8', '10', '12', '14']);
  });

  it('only managers set them up, and each garment needs a price and sizes', async () => {
    await expect(createTeamOrder(staff, setup, [])).rejects.toThrow(/manager/);
    const e = await make({ item1_price: '', item2_sizes: '' }).then(() => null, (x) => x.fieldErrors);
    expect(e).toHaveProperty('item1_price');
    expect(e).toHaveProperty('item2_sizes');
  });

  it('one garment makes a simple order; several make one multi-item order, name charged per item', async () => {
    const team = await make();
    expect(team.items.map((i) => [i.product, i.pricePence])).toEqual([['Arwen polo', 4999], ['Ava 1/4 zip', 5999], ['Asha sweater', 7499]]);
    expect(team.items[0].sizes).toEqual(['8', '10', '12', '14']);
    const [polo, zip, sweater] = team.items;

    const one = await submitTeamOrder(team.token, member({ [`size_${polo.id}`]: '12' }), { ip: '1.1.1.1' });
    expect(one.total).toBe(4999);
    const [o1] = await withTenant(org.id, (tx) => tx.select().from(orders).where(eq(orders.id, one.order.id)));
    expect(o1.product).toBe('Arwen polo');
    expect(o1.specificationText).toContain('Size: 12');
    expect(o1.category).toBe('Clothing');

    const three = await submitTeamOrder(
      team.token,
      member({ [`size_${polo.id}`]: '10', [`size_${zip.id}`]: '10', [`size_${sweater.id}`]: '12', addName: 'yes', printedName: '  Kate   O’Neil ' }),
      { ip: '1.1.1.1' },
    );
    expect(three.total).toBe(4999 + 5999 + 7499 + 3 * 500);
    expect(three.printedName).toBe('Kate O’Neil');
    const [o3] = await withTenant(org.id, (tx) => tx.select().from(orders).where(eq(orders.id, three.order.id)));
    expect(o3.totalGrossPence).toBe(three.total);
    expect(o3.status).toBe('place_order');
    expect(o3.specificationText).toContain('3 items:');
    expect(o3.specificationText).toContain('Name: Kate O’Neil (right chest)');
    expect(o3.internalNotes).toContain('Team order: Ladies team kit');
    const spec = o3.specificationJson as { kind: string; items: { product: string; size: string; unitPricePence: number }[] };
    expect(spec.kind).toBe('cos-items');
    expect(spec.items.map((i) => [i.product, i.size, i.unitPricePence])).toEqual([['Arwen polo', '10', 5499], ['Ava 1/4 zip', '10', 6499], ['Asha sweater', '12', 7999]]);
    const sent = await withTenant(org.id, (tx) => tx.select().from(messages).where(eq(messages.orderId, o3.id)));
    expect(sent.filter((m) => m.templateType === 'order_confirmation')).toHaveLength(1);

    const d = (await teamOrderDetail(org.id, team.id))!;
    expect(d.totals).toEqual({ orders: 2, garments: 4, named: 3, value: one.total + three.total });
    expect(d.items[0].sizes.find((s) => s.size === '10')).toEqual({ size: '10', total: 1, named: 1 });
    expect(d.items[0].total).toBe(2);
    expect(d.items[2].sizes.find((s) => s.size === '12')).toEqual({ size: '12', total: 1, named: 1 });
    const csv = teamCsv(d);
    expect(csv).toContain('Kate O’Neil');
    expect(csv).toContain('Asha sweater,12,1,1');
  });

  it('checks sizes, name and acceptance', async () => {
    const team = await make();
    const polo = team.items[0].id;
    const err = (raw: Record<string, string>) => submitTeamOrder(team.token, raw, { ip: null }).then(() => null, (e) => e.fieldErrors);
    expect(await err(member())).toHaveProperty('items');
    expect(await err(member({ [`size_${polo}`]: '22' }))).toHaveProperty(`size_${polo}`);
    expect(await err(member({ [`size_${polo}`]: '12', accept: '' }))).toHaveProperty('accept');
    expect(await err(member({ [`size_${polo}`]: '12', addName: 'yes', printedName: '' }))).toHaveProperty('printedName');
    expect(await err(member({ [`size_${polo}`]: '12', addName: 'yes', printedName: '<script>' }))).toHaveProperty('printedName');
    expect(await err(member({ [`size_${polo}`]: '12', addName: 'yes', printedName: 'A'.repeat(21) }))).toHaveProperty('printedName');
    // A name typed without ticking the box isn't charged or printed.
    const r = await submitTeamOrder(team.token, member({ [`size_${polo}`]: '12', printedName: 'Sneaky' }), { ip: null });
    expect(r.total).toBe(4999);
    expect(r.printedName).toBe('');
  });

  it('keeps garment ids when edited, and stops taking orders once closed', async () => {
    const team = await make();
    await updateTeamOrder(manager, team.id, { ...setup, item0_id: team.items[0].id, item0_price: '45.00', item1_product: '', item1_id: team.items[1].id, item2_id: team.items[2].id }, []);
    const d = (await teamOrderDetail(org.id, team.id))!;
    expect(d.team.items.map((i) => i.id)).toEqual([team.items[0].id, team.items[2].id]);
    expect(d.team.items[0].pricePence).toBe(4500);

    await setTeamOrderClosed(manager, team.id, true);
    await expect(submitTeamOrder(team.token, member({ [`size_${team.items[0].id}`]: '8' }), { ip: null })).rejects.toThrow(/closed/);
    await setTeamOrderClosed(manager, team.id, false);
    await submitTeamOrder(team.token, member({ [`size_${team.items[0].id}`]: '8' }), { ip: null });
    const past = await make({ closesOn: '2020-01-01' });
    await expect(submitTeamOrder(past.token, member({ [`size_${past.items[0].id}`]: '8' }), { ip: null })).rejects.toThrow(/closed/);
    await expect(submitTeamOrder('not-a-real-token-123', member(), { ip: null })).rejects.toThrow(/isn’t available/);
  });
});
