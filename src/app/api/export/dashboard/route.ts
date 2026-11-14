import { withTenant } from '@/db';
import { getPerformance, parsePeriod } from '@/lib/analytics';
import { recordEvent, staffActor } from '@/lib/audit';
import { getStaff, hasRole } from '@/lib/auth';
import { dashboardCsv } from '@/lib/performance-report';

/** The landing dashboard as one CSV. Managers and owners only (it includes customer spending). */
export async function GET(req: Request) {
  const staff = await getStaff();
  if (!staff) return new Response('Unauthorised', { status: 401 });
  if (!hasRole(staff, 'manager')) return new Response('Only a manager or owner can download the dashboard.', { status: 403 });
  const period = parsePeriod(new URL(req.url).searchParams.get('period') ?? undefined);
  const p = await getPerformance(staff.org, period);
  const today = new Date().toISOString().slice(0, 10);
  const csv = dashboardCsv(staff.org, p, today);

  await withTenant(staff.organisationId, (tx) =>
    recordEvent(tx, {
      organisationId: staff.organisationId, actor: staffActor(staff), eventType: 'data_exported', entityType: 'organisation',
      entityId: staff.organisationId, metadata: { format: 'csv', report: 'dashboard', period },
    }),
  );

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="dashboard-${period}-${today}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
