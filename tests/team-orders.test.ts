import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setDatabaseHandle, systemDb, withTenant } from '@/db';
import { runMigrations } from '@/db/migrate';
import { messages, orders, organisations, users, type Organisation } from '@/db/schema';
import { seedDemo } from '@/db/seed';
import { staffActor } from '@/lib/audit';
import type { Ctx } from '@/lib/services/common';
import { createTeamOrder, parseSizes, setTeamOrderClosed, submitTeamOrder, teamCsv, teamOrderDetail } from '@/lib/services/team-orders';

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
  title: 'Ladies team polo', teamName: 'Wheatley Ladies', brand: 'Glenmuir', product: 'Ladies scallop trim polo', colour: 'Berry',
  sizes: '8, 10, 12, 12, 14', price: '49.99', namePrice: '5', namePlacement: 'Right chest', nameMaxLength: '20', terms: '', closesOn: '',
  description: 'Includes the club crest on the left chest.',
};
const member = (o: Record<string, string> = {}) => ({
  size: '12', customerName: 'Sarah Jones', email: `m-${Math.random().toString(36).slice(2)}@example.com`, phone: '', accept: 'yes', ...o,
});

describe('team order links', () => {
  it('parses sizes, de-duplicated', () => {
    expect(parseSizes('8, 10,\n12, 12 , ,14')).toEqual(['8', '10', '12', '14']);
  });

  it('only managers set them up', async () => {
    await expect(createTeamOrder(staff, setup, null)).rejects.toThrow(/manager/);
  });

  it('turns each response into an order at the right price, with or without a name', async () => {
    const team = await createTeamOrder(manager, setup, null);
    expect(team.sizes).toEqual(['8', '10', '12', '14']);
    expect(team.pricePence).toBe(4999);
    expect(team.namePricePence).toBe(500);
    expect(team.terms).toMatch(/can’t be returned/);

    const plain = await submitTeamOrder(team.token, member(), { ip: '1.1.1.1' });
    expect(plain.total).toBe(4999);
    const named = await submitTeamOrder(team.token, member({ size: '10', addName: 'yes', printedName: '  Kate   O’Neil ' }), { ip: '1.1.1.1' });
    expect(named.total).toBe(5499);
    expect(named.printedName).toBe('Kate O’Neil');

    const [o] = await withTenant(org.id, (tx) => tx.select().from(orders).where(eq(orders.id, named.order.id)));
    expect(o.status).toBe('place_order');
    expect(o.brand).toBe('Glenmuir');
    expect(o.category).toBe('Clothing');
    expect(o.totalGrossPence).toBe(5499);
    expect(o.specificationText).toContain('Size: 10');
    expect(o.specificationText).toContain('Name: Kate O’Neil (right chest) +£5.00');
    expect(o.internalNotes).toContain('Team order: Ladies team polo');
    const sent = await withTenant(org.id, (tx) => tx.select().from(messages).where(eq(messages.orderId, o.id)));
    expect(sent.some((m) => m.templateType === 'order_confirmation')).toBe(true);

    const d = (await teamOrderDetail(org.id, team.id))!;
    expect(d.totals).toEqual({ count: 2, named: 1, value: 4999 + 5499 });
    expect(d.sizes.find((s) => s.size === '10')).toEqual({ size: '10', total: 1, named: 1 });
    expect(d.sizes.find((s) => s.size === '12')).toEqual({ size: '12', total: 1, named: 0 });
    const csv = teamCsv(d);
    expect(csv).toContain('Kate O’Neil');
    expect(csv).toContain('10,1,1');
  });

  it('checks size, name and acceptance', async () => {
    const team = await createTeamOrder(manager, setup, null);
    const err = (raw: Record<string, string>) => submitTeamOrder(team.token, raw, { ip: null }).then(() => null, (e) => e.fieldErrors);
    expect(await err(member({ size: '22' }))).toHaveProperty('size');
    expect(await err(member({ accept: '' }))).toHaveProperty('accept');
    expect(await err(member({ addName: 'yes', printedName: '' }))).toHaveProperty('printedName');
    expect(await err(member({ addName: 'yes', printedName: '<script>' }))).toHaveProperty('printedName');
    expect(await err(member({ addName: 'yes', printedName: 'A'.repeat(21) }))).toHaveProperty('printedName');
    // A name typed without ticking the box isn't charged or printed.
    const r = await submitTeamOrder(team.token, member({ printedName: 'Sneaky' }), { ip: null });
    expect(r.total).toBe(4999);
    expect(r.printedName).toBe('');
  });

  it('stops taking orders once closed or past its closing date', async () => {
    const team = await createTeamOrder(manager, setup, null);
    await setTeamOrderClosed(manager, team.id, true);
    await expect(submitTeamOrder(team.token, member(), { ip: null })).rejects.toThrow(/closed/);
    await setTeamOrderClosed(manager, team.id, false);
    await submitTeamOrder(team.token, member(), { ip: null });
    const past = await createTeamOrder(manager, { ...setup, closesOn: '2020-01-01' }, null);
    await expect(submitTeamOrder(past.token, member(), { ip: null })).rejects.toThrow(/closed/);
    await expect(submitTeamOrder('not-a-real-token-123', member(), { ip: null })).rejects.toThrow(/isn’t available/);
  });
});
