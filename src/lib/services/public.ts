import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { systemDb, withTenant } from '@/db';
import { attachments, auditEvents, customers, orders, organisations, trackingTokens } from '@/db/schema';
import { paidPence } from './common';
import { hashToken } from '../tokens';

/** Events a customer may see. Internal notes, staff names and supplier details are excluded. */
const CUSTOMER_EVENTS = ['order_created', 'status_changed', 'order_ready', 'order_collected', 'eta_changed'];

export async function findOrderByTrackingToken(token: string) {
  if (!/^[\w-]{20,100}$/.test(token)) return null;
  const [hit] = await systemDb()
    .select({ orgId: trackingTokens.organisationId, orderId: trackingTokens.orderId })
    .from(trackingTokens)
    .where(and(eq(trackingTokens.tokenHash, hashToken(token)), isNull(trackingTokens.revokedAt), gt(trackingTokens.expiresAt, new Date())))
    .limit(1);
  if (!hit) return null;
  const [org] = await systemDb().select().from(organisations).where(eq(organisations.id, hit.orgId)).limit(1);
  return withTenant(hit.orgId, async (tx) => {
    const [row] = await tx
      .select({ order: orders, customerName: customers.name })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(and(eq(orders.id, hit.orderId), isNull(orders.archivedAt)))
      .limit(1);
    if (!row) return null;
    const [events, files, paid] = await Promise.all([
      tx
        .select({ eventType: auditEvents.eventType, oldValueJson: auditEvents.oldValueJson, newValueJson: auditEvents.newValueJson, metadataJson: auditEvents.metadataJson, createdAt: auditEvents.createdAt })
        .from(auditEvents)
        .where(and(eq(auditEvents.orderId, hit.orderId), inArray(auditEvents.eventType, CUSTOMER_EVENTS)))
        .orderBy(asc(auditEvents.createdAt)),
      tx
        .select({ id: attachments.id, filename: attachments.filename, category: attachments.category })
        .from(attachments)
        .where(and(eq(attachments.orderId, hit.orderId), eq(attachments.visibility, 'customer-visible'), isNull(attachments.archivedAt))),
      paidPence(tx, hit.orderId),
    ]);
    const o = row.order;
    return {
      org,
      // Explicit allow-list of customer-safe fields.
      order: {
        orderNumber: o.orderNumber, status: o.status, brand: o.brand, product: o.product, specificationText: o.specificationText,
        totalGrossPence: o.totalGrossPence, etaDate: o.etaDate, etaReason: o.etaReason, createdAt: o.createdAt,
      },
      customerName: row.customerName,
      paid,
      balance: o.totalGrossPence - paid,
      events,
      files,
    };
  });
}

/** Customer-visible attachment download, authorised by the tracking token. */
export async function findPublicAttachment(token: string, attachmentId: string) {
  const found = await findOrderByTrackingToken(token);
  if (!found || !found.files.some((f) => f.id === attachmentId)) return null;
  return withTenant(found.org.id, async (tx) => (await tx.select().from(attachments).where(eq(attachments.id, attachmentId)).limit(1))[0] ?? null);
}
