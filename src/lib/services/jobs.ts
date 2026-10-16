import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { systemDb, withTenant } from '@/db';
import { customers, orders, organisations } from '@/db/schema';
import { SYSTEM } from '../audit';
import { dispatchMessages, enqueueEmail } from '../email/outbox';
import { hasFeature } from '../plans';
import { issueTrackingLink, paymentTotals } from './common';
import { orderEmailContext } from './orders';
import { runBackup } from './backups';
import { runMonthlyReport } from './performance-report';

/**
 * Daily scheduled work (Vercel Cron → /api/cron/daily):
 * - collection reminders for orders ready but uncollected beyond the org threshold
 * - nightly COS-hosted backup for plans that include it
 * - the monthly performance report, once each month has finished
 */
export async function runDailyJobs(now = new Date()) {
  const orgs = await systemDb().select().from(organisations);
  const summary: Record<string, { reminders: number; backup: string; report: string }> = {};

  for (const org of orgs) {
    const cutoff = new Date(now.getTime() - org.readyUncollectedDays * 86_400_000);
    const ids = await withTenant(org.id, async (tx) => {
      const due = await tx
        .select({ order: orders, customer: customers })
        .from(orders)
        .innerJoin(customers, eq(customers.id, orders.customerId))
        .where(
          and(
            eq(orders.status, 'ready'),
            isNull(orders.archivedAt),
            lt(orders.readyAt, cutoff),
            // At most one reminder per threshold period.
            or(isNull(orders.lastReminderAt), lt(orders.lastReminderAt, cutoff)),
          ),
        );
      const out: (string | null)[] = [];
      for (const { order, customer } of due) {
        const totals = await paymentTotals(tx, order.id);
        const link = await issueTrackingLink(tx, org.id, order.id);
        out.push(
          await enqueueEmail(tx, {
            org,
            template: 'collection_reminder',
            recipient: customer.email,
            customerId: customer.id,
            orderId: order.id,
            context: orderEmailContext(order, customer, totals, link),
            actor: SYSTEM,
          }),
        );
        await tx.update(orders).set({ lastReminderAt: now }).where(eq(orders.id, order.id));
      }
      return out;
    });
    await dispatchMessages(org, ids);

    let backup = 'skipped (plan)';
    if (hasFeature(org, 'backup.cos_hosted')) {
      try {
        await runBackup(org, 'cos_hosted', { type: 'system', label: 'COS nightly backup' }, null);
        backup = 'ok';
      } catch (e) {
        backup = `failed: ${e instanceof Error ? e.message : e}`;
      }
    }
    let report: string;
    try {
      report = await runMonthlyReport(org, { type: 'system', label: 'COS monthly report' }, now);
    } catch (e) {
      report = `failed: ${e instanceof Error ? e.message : e}`;
    }
    summary[org.slug] = { reminders: ids.length, backup, report };
  }
  return summary;
}
