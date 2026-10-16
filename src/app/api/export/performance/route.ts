import { withTenant } from '@/db';
import { getPerformance, parsePeriod } from '@/lib/analytics';
import { recordEvent, staffActor } from '@/lib/audit';
import { getStaff, hasRole } from '@/lib/auth';
import { performanceCsv } from '@/lib/performance-report';

/** The Performance view's figures as one CSV, a titled section per table. Managers and owners only (it includes team sales). */
export async function GET(req: Request) {
  const staff = await getStaff();
  if (!staff) return new Response('Unauthorised', { status: 401 });
  if (!hasRole(staff, 'manager')) return new Response('Only a manager or owner can export performance figures.', { status: 403 });
  const period = parsePeriod(new URL(req.url).searchParams.get('period') ?? undefined);
  const p = await getPerformance(staff.org, period);
  const today = new Date().toISOString().slice(0, 10);
  const csv = performanceCsv(staff.org, p, today);

  await withTenant(staff.organisationId, (tx) =>
    recordEvent(tx, {
      organisationId: staff.organisationId, actor: staffActor(staff), eventType: 'data_exported', entityType: 'organisation',
      entityId: staff.organisationId, metadata: { format: 'csv', report: 'performance', period },
    }),
  );

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="performance-${period}-${today}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
