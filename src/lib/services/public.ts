import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { systemDb, withTenant } from '@/db';
import { attachments, auditEvents, customers, orders, organisations, trackingTokens, workshopItems, workshopJobs } from '@/db/schema';
import { proofOf } from '../proofs';
import { fitSpec } from '../fit-spec';
import { journeyFor } from '../status';
import { hashToken } from '../tokens';
import { paymentTotals } from './common';
import { proofPathFor } from './quotes';

/** Events a customer may see. Internal notes, staff names and supplier details are excluded. */
const CUSTOMER_EVENTS = ['order_created', 'status_changed', 'order_ready', 'order_collected', 'eta_changed'];

export async function findOrderByTrackingToken(token: string) {
  if (!/^[\w-]{20,100}$/.test(token)) return null;
  const [hit] = await systemDb()
    .select({ orgId: trackingTokens.organisationId, orderId: trackingTokens.orderId })
    .from(trackingTokens)
    .where(and(eq(trackingTokens.tokenHash, hashToken(token)), isNull(trackingTokens.revokedAt), gt(trackingTokens.expiresAt, new Date())))
    .limit(1);
  // Workshop links share the table; they're read by findWorkshopByToken.
  if (!hit?.orderId) return null;
  const orderId = hit.orderId;
  const [org] = await systemDb().select().from(organisations).where(eq(organisations.id, hit.orgId)).limit(1);
  return withTenant(hit.orgId, async (tx) => {
    const [row] = await tx
      .select({ order: orders, customerName: customers.name })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(and(eq(orders.id, orderId), isNull(orders.archivedAt)))
      .limit(1);
    if (!row) return null;
    const [events, files, totals] = await Promise.all([
      tx
        .select({ eventType: auditEvents.eventType, oldValueJson: auditEvents.oldValueJson, newValueJson: auditEvents.newValueJson, metadataJson: auditEvents.metadataJson, createdAt: auditEvents.createdAt })
        .from(auditEvents)
        .where(and(eq(auditEvents.orderId, orderId), inArray(auditEvents.eventType, CUSTOMER_EVENTS)))
        .orderBy(asc(auditEvents.createdAt)),
      tx
        .select({ id: attachments.id, filename: attachments.filename, category: attachments.category })
        .from(attachments)
        .where(and(eq(attachments.orderId, orderId), eq(attachments.visibility, 'customer-visible'), isNull(attachments.archivedAt))),
      paymentTotals(tx, orderId),
    ]);
    const o = row.order;
    return {
      org,
      // Explicit allow-list of customer-safe fields.
      order: {
        orderNumber: o.orderNumber, status: o.status, brand: o.brand, product: o.product, specificationText: o.specificationText,
        totalGrossPence: o.totalGrossPence, etaDate: o.etaDate, etaReason: o.etaReason, createdAt: o.createdAt,
        // Only the customer-facing build lines, never internal catalogue ids.
        specificationJson: fitSpec(o.specificationJson),
      },
      journey: journeyFor(o.specificationJson),
      proofUrl: o.quoteId && proofOf(o.specificationJson) ? proofPathFor(o.quoteId) : null,
      customerName: row.customerName,
      paid: totals.paid,
      credit: totals.credit,
      balance: o.totalGrossPence - totals.paid - totals.credit,
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

/** A customer's workshop job by its tracking link: customer-safe fields only (no internal notes or staff names). */
export async function findWorkshopByToken(token: string) {
  if (!/^[\w-]{20,100}$/.test(token)) return null;
  const [hit] = await systemDb()
    .select({ orgId: trackingTokens.organisationId, jobId: trackingTokens.workshopJobId })
    .from(trackingTokens)
    .where(and(eq(trackingTokens.tokenHash, hashToken(token)), isNull(trackingTokens.revokedAt), gt(trackingTokens.expiresAt, new Date())))
    .limit(1);
  if (!hit?.jobId) return null;
  const jobId = hit.jobId;
  const [org] = await systemDb().select().from(organisations).where(eq(organisations.id, hit.orgId)).limit(1);
  return withTenant(hit.orgId, async (tx) => {
    const [row] = await tx
      .select({ job: workshopJobs, customerName: customers.name })
      .from(workshopJobs)
      .innerJoin(customers, eq(customers.id, workshopJobs.customerId))
      .where(and(eq(workshopJobs.id, jobId), isNull(workshopJobs.archivedAt)))
      .limit(1);
    if (!row) return null;
    const items = await tx
      .select({ club: workshopItems.club, work: workshopItems.work, parts: workshopItems.parts, quantity: workshopItems.quantity, pricePence: workshopItems.pricePence })
      .from(workshopItems)
      .where(and(eq(workshopItems.jobId, jobId), isNull(workshopItems.removedAt)))
      .orderBy(asc(workshopItems.createdAt));
    const j = row.job;
    return {
      org,
      customerName: row.customerName,
      job: {
        reference: j.reference, status: j.status, etaDate: j.etaDate, createdAt: j.createdAt, readyAt: j.readyAt, collectedAt: j.collectedAt,
        // The reason is only shown while it applies.
        delayReason: j.status === 'waiting_parts' ? j.delayReason : '',
      },
      items,
    };
  });
}
