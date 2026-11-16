import { getStaff } from '@/lib/auth';
import { teamCsv, teamOrderDetail } from '@/lib/services/team-orders';

/** Staff download: everyone who ordered through a team link, plus the size totals. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await getStaff();
  if (!staff) return new Response('Unauthorised', { status: 401 });
  const d = await teamOrderDetail(staff.organisationId, (await params).id);
  if (!d) return new Response('Not found', { status: 404 });
  const name = d.team.title.replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'team-order';
  return new Response(teamCsv(d), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"`, 'Cache-Control': 'private, no-store' },
  });
}
