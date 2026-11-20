import { getStaff } from '@/lib/auth';
import { ballPromotionDetail, promoCsv } from '@/lib/services/ball-promotions';

/** Staff download: every design sent through a ball promotion, plus the dozens per ball. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await getStaff();
  if (!staff) return new Response('Unauthorised', { status: 401 });
  const d = await ballPromotionDetail(staff.organisationId, (await params).id);
  if (!d) return new Response('Not found', { status: 404 });
  const name = d.promo.title.replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'ball-promotion';
  return new Response(promoCsv(d), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"`, 'Cache-Control': 'private, no-store' },
  });
}
