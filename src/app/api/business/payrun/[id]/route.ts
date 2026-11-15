import { withTenant } from '@/db';
import { ctxFor } from '@/lib/action-utils';
import { recordEvent } from '@/lib/audit';
import { requireBusiness } from '@/lib/business-lock';
import { getPayRun, payRunCsv } from '@/lib/services/business/payroll';

/** The pay run as a CSV (owner only, unlocked). */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await requireBusiness({ renew: true });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
  const data = await getPayRun(staff.organisationId, id);
  if (!data) return new Response('Not found', { status: 404 });
  const ctx = ctxFor(staff);
  await withTenant(staff.organisationId, (tx) =>
    recordEvent(tx, {
      organisationId: staff.organisationId, actor: ctx.actor, eventType: 'data_exported', entityType: 'organisation', entityId: staff.organisationId,
      metadata: { report: 'pay_run', payRunId: id },
    }),
  );
  return new Response(payRunCsv(data), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="pay-run-${data.run.periodStart}-to-${data.run.periodEnd}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
