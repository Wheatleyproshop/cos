import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setDatabaseHandle, systemDb, withTenant } from '@/db';
import { runMigrations } from '@/db/migrate';
import { organisations, quotes, users, type Organisation } from '@/db/schema';
import { seedDemo } from '@/db/seed';
import { staffActor } from '@/lib/audit';
import { asBallPrintSpec } from '@/lib/ball-print';
import type { Ctx } from '@/lib/services/common';

vi.mock('server-only', () => ({}));

let close: () => Promise<void>;
let org: Organisation;
let staff: Ctx;
let manager: Ctx;
const proof = () => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1])], 'proof.jpg', { type: 'image/jpeg' });

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
  const { getBallRange, addStarterBalls, addBall } = await import('@/lib/services/ball-printing');
  if (!(await getBallRange(org.id)).length) await addStarterBalls(manager);
  await addBall(manager, { brand: 'Titleist', name: 'Pro V1x Left Dash', colour: '#ffffff', pricePerDozenPence: '64.99', minDozens: '1', leadTimeDays: '14' });
});

afterAll(async () => close());

describe('ball promotions (e.g. Titleist No.1 Gift in Golf)', () => {
  it('sets up a promotion on chosen balls at promotion prices, and only managers can', async () => {
    const svc = await import('@/lib/services/ball-promotions');
    const { getBallRange } = await import('@/lib/services/ball-printing');
    const range = await getBallRange(org.id);
    const pick = (name: string) => range.find((b) => b.brand === 'Titleist' && b.name === name)!;
    const v1 = pick('Pro V1');
    const yellow = pick('Pro V1 Yellow');
    const v1x = pick('Pro V1x');
    const dash = pick('Pro V1x Left Dash');
    const form: Record<string, string> = {
      title: 'Titleist No.1 Gift in Golf', headline: 'Personalised Pro V1', closesOn: '2099-12-24', setupFee: '0', minDozens: '1',
      [`ball_${v1.id}`]: 'yes', [`price_${v1.id}`]: '54.99', [`ball_${yellow.id}`]: 'yes', [`price_${yellow.id}`]: '54.99',
      [`ball_${v1x.id}`]: 'yes', [`price_${v1x.id}`]: '54.99', [`ball_${dash.id}`]: 'yes', [`price_${dash.id}`]: '',
    };
    await expect(svc.createBallPromotion(staff, form)).rejects.toThrow();
    await expect(svc.createBallPromotion(manager, { title: 'Nothing ticked' })).rejects.toMatchObject({ fieldErrors: { balls: 'Tick at least one ball' } });
    const p = await svc.createBallPromotion(manager, form);
    expect(p.balls).toEqual([
      expect.objectContaining({ ballId: expect.any(String) }),
      expect.anything(), expect.anything(), expect.anything(),
    ]);
    // A blank price means the ball's usual price.
    expect(p.balls.find((b) => b.ballId === dash.id)!.pricePerDozenPence).toBe(6499);
    expect(p.balls.find((b) => b.ballId === v1.id)!.pricePerDozenPence).toBe(5499);
    expect(p.token).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const found = await svc.findBallPromotion(p.token);
    expect(found!.balls.map((b) => b.name).sort()).toEqual(['Pro V1', 'Pro V1 Yellow', 'Pro V1x', 'Pro V1x Left Dash']);
  });

  it('turns a customer design into a quote at the promotion price, tagged with the promotion, with a tally', async () => {
    const svc = await import('@/lib/services/ball-promotions');
    const [p] = await svc.listBallPromotions(org.id);
    const found = (await svc.findBallPromotion(p.token))!;
    const yellow = found.balls.find((b) => b.name === 'Pro V1 Yellow')!;
    const design = {
      customerName: 'Gift Buyer', email: 'gift@example.com', phone: '', ballId: yellow.id, artworkType: 'text', textLines: ['Happy Christmas Dad', '', ''],
      font: 'classic', ink: 'navy', scale: '0.8', dozens: '3', notes: '',
      // A customer can't set their own price.
      pricePerDozenPence: '0.01', setupFeePence: '0',
    };
    const q = await svc.submitPromotionDesign(p.token, design, { logo: null, proof: proof() }, { ip: '203.0.113.20' });
    expect(q.status).toBe('draft');
    expect(q.totalGrossPence).toBe(3 * 5499);
    const [row] = await withTenant(org.id, (tx) => tx.select().from(quotes).where(eq(quotes.id, q.id)));
    expect(asBallPrintSpec(row.specificationJson)!.promo).toEqual({ id: p.id, title: 'Titleist No.1 Gift in Golf' });
    expect(row.specificationText).toContain('Promotion: Titleist No.1 Gift in Golf');

    // Only the promotion's balls can be ordered through it.
    const { getBallRange } = await import('@/lib/services/ball-printing');
    const avx = (await getBallRange(org.id)).find((b) => b.name === 'AVX')!;
    await expect(svc.submitPromotionDesign(p.token, { ...design, ballId: avx.id }, { logo: null, proof: proof() }, { ip: '203.0.113.20' })).rejects.toThrow(
      /balls in this promotion/,
    );

    const d = (await svc.ballPromotionDetail(org.id, p.id))!;
    expect(d.totals).toEqual({ designs: 1, dozens: 3, value: 3 * 5499 });
    expect(d.balls.find((b) => b.name === 'Pro V1 Yellow')).toMatchObject({ designs: 1, dozens: 3 });
    expect(svc.promoCsv(d)).toContain('Titleist Pro V1 Yellow,1,3');
  });

  it('keeps campaign images: added, kept on edit, removed on request', async () => {
    const svc = await import('@/lib/services/ball-promotions');
    const [p] = await svc.listBallPromotions(org.id);
    const form: Record<string, string> = { title: p.title, headline: p.headline, setupFee: '0', minDozens: '1' };
    for (const b of p.balls) Object.assign(form, { [`ball_${b.ballId}`]: 'yes', [`price_${b.ballId}`]: (b.pricePerDozenPence / 100).toFixed(2) });
    await svc.updateBallPromotion(manager, p.id, form, { banner: proof(), feature: proof() });
    let found = (await svc.findBallPromotion(p.token))!;
    expect(found.promo.bannerMime).toBe('image/jpeg');
    expect(svc.promoImagePath(found.promo, 'banner')).toMatch(new RegExp(`^/api/public/promo-image/${p.token}/banner\\?v=`));
    const banner = found.promo.bannerKey;
    await svc.updateBallPromotion(manager, p.id, { ...form, remove_feature: 'yes' });
    found = (await svc.findBallPromotion(p.token))!;
    expect(found.promo.bannerKey).toBe(banner);
    expect(found.promo.featureKey).toBeNull();
    // Not an image: refused.
    const txt = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])], 'x.png', { type: 'image/png' });
    await expect(svc.updateBallPromotion(manager, p.id, form, { banner: txt })).rejects.toThrow(/PNG, JPG or WebP/);
  });

  it('stops taking designs once closed', async () => {
    const svc = await import('@/lib/services/ball-promotions');
    const [p] = await svc.listBallPromotions(org.id);
    await svc.setBallPromotionClosed(manager, p.id, true);
    const found = (await svc.findBallPromotion(p.token))!;
    await expect(
      svc.submitPromotionDesign(
        p.token,
        { customerName: 'Late', email: 'late@example.com', ballId: found.balls[0].id, artworkType: 'text', textLines: ['Late'], dozens: '1' },
        { logo: null, proof: proof() },
        { ip: '203.0.113.21' },
      ),
    ).rejects.toThrow(/closed/);
    await svc.setBallPromotionClosed(manager, p.id, false);
    expect(svc.isPromoOpen({ closedAt: null, closesOn: '2020-01-01' }, '2026-11-20')).toBe(false);
  });
});
