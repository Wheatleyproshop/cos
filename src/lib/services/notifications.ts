import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { withTenant } from '@/db';
import { auditEvents, customers, orders, quotes, users, workshopJobs } from '@/db/schema';
import { templateName } from '../audit';

/** Ledger events worth interrupting staff for. Your own actions are never notified back to you. */
const NOTIFY = ['order_created', 'quote_accepted', 'order_ready', 'email_failed', 'backup_failed', 'workshop_job_created', 'ball_design_submitted'];

export type NotificationItem = { id: string; title: string; body: string; href: string; at: string; unread: boolean };

export async function listNotifications(orgId: string, userId: string, limit = 20) {
  return withTenant(orgId, async (tx) => {
    const [me] = await tx.select({ seen: users.notificationsSeenAt }).from(users).where(eq(users.id, userId)).limit(1);
    const rows = await tx
      .select({ e: auditEvents, orderNumber: orders.orderNumber, quoteNumber: quotes.quoteNumber, customer: customers.name, jobRef: workshopJobs.reference })
      .from(auditEvents)
      .leftJoin(orders, eq(orders.id, auditEvents.orderId))
      .leftJoin(quotes, eq(quotes.id, auditEvents.quoteId))
      .leftJoin(customers, eq(customers.id, auditEvents.customerId))
      .leftJoin(workshopJobs, and(eq(auditEvents.entityType, 'workshop_job'), eq(workshopJobs.id, auditEvents.entityId)))
      .where(
        and(
          or(
            inArray(auditEvents.eventType, NOTIFY),
            // Workshop jobs: only the moments staff need to act on.
            and(eq(auditEvents.eventType, 'workshop_status_changed'), sql`${auditEvents.newValueJson}->>'status' in ('ready', 'waiting_parts')`),
          ),
          or(isNull(auditEvents.actorUserId), ne(auditEvents.actorUserId, userId)),
        ),
      )
      .orderBy(desc(auditEvents.createdAt))
      .limit(limit);
    const seen = me?.seen ?? new Date(0);
    const items: NotificationItem[] = rows.map(({ e, orderNumber, quoteNumber, customer, jobRef }) => {
      const m = (e.metadataJson ?? {}) as Record<string, string>;
      const n = (e.newValueJson ?? {}) as Record<string, string>;
      const ref = orderNumber ?? quoteNumber ?? jobRef ?? '';
      const href = orderNumber ? `/orders/${orderNumber}` : quoteNumber ? `/quotes/${quoteNumber}` : jobRef ? `/workshop/${jobRef}` : '/settings';
      const who = customer ? ` for ${customer}` : '';
      const [title, body] =
        e.eventType === 'ball_design_submitted'
          ? ['New golf ball design to review', `${ref}${customer ? ` from ${customer}` : ''} — designed online`]
          : e.eventType === 'workshop_job_created'
          ? ['Clubs checked in to the workshop', `${ref}${who} — checked in by ${e.actorLabel}`]
          : e.eventType === 'workshop_status_changed' && n.status === 'ready'
            ? ['Workshop job ready', `${ref}${who} marked ready by ${e.actorLabel}`]
            : e.eventType === 'workshop_status_changed'
              ? ['Workshop job waiting for parts', `${ref}${who}${n.delayReason ? ` — ${n.delayReason}` : ''}`]
              : e.eventType === 'order_created'
          ? ['New order received', `Order ${ref}${customer ? ` from ${customer}` : ''} — taken by ${e.actorLabel}`]
          : e.eventType === 'quote_accepted'
            ? ['Quote approved', `${quoteNumber ?? 'A quote'} approved by ${n.acceptedName ?? customer ?? 'the customer'}`]
            : e.eventType === 'order_ready'
              ? ['Ready for collection', `${ref}${customer ? ` for ${customer}` : ''} marked ready by ${e.actorLabel}`]
              : e.eventType === 'email_failed'
                ? ['Email not delivered', `${templateName(m.template)} to ${m.recipient ?? customer ?? 'customer'} failed${ref ? ` (${ref})` : ''}`]
                : ['Backup failed', String(m.error ?? 'See Store settings')];
      return { id: e.id, title, body, href, at: e.createdAt.toISOString(), unread: e.createdAt > seen };
    });
    return { items, unread: items.filter((i) => i.unread).length };
  });
}

export async function markNotificationsSeen(orgId: string, userId: string) {
  await withTenant(orgId, (tx) => tx.update(users).set({ notificationsSeenAt: new Date() }).where(eq(users.id, userId)));
}
