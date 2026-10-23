import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { withTenant, type DB } from '@/db';
import { attachments, auditEvents, customers, orders, payments, type Customer, type Order } from '@/db/schema';
import { recordEvent } from '../audit';
import { dispatchMessages, enqueueEmail } from '../email/outbox';
import type { EmailContext } from '../email/templates';
import { ALLOWED_UPLOAD_TYPES, MAX_UPLOAD_BYTES, storage } from '../storage';
import { fitSpec } from '../fit-spec';
import { money } from '../format';
import { composeSpec } from '../order-details';
import { canTransition, journeyFor, statusLabel } from '../status';
import { newToken } from '../tokens';
import {
  attachmentMetaSchema,
  noteSchema,
  orderCreateSchema,
  orderEditSchema,
  orderUpdateSchema,
  parse,
  paymentSchema,
} from '../validation';
import { atLeast, findOrCreateCustomer, issueTrackingLink, nextNumber, paidPence, paymentTotals, requireRole, ServiceError, type Ctx, type PaymentTotals } from './common';

async function loadOrder(tx: DB, ctx: Ctx, orderId: string) {
  const [row] = await tx
    .select({ order: orders, customer: customers })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(and(eq(orders.id, orderId), eq(orders.organisationId, ctx.org.id)))
    .for('update', { of: orders })
    .limit(1);
  if (!row) throw new ServiceError('Order not found.');
  return row;
}

export function orderEmailContext(o: Order, c: Customer, t: PaymentTotals, actionUrl?: string): Omit<EmailContext, 'store'> {
  return {
    customerName: c.name,
    reference: o.orderNumber,
    brand: o.brand,
    product: o.product,
    specification: o.specificationText,
    totalPence: o.totalGrossPence,
    paidPence: t.paid,
    creditPence: t.credit,
    balancePence: o.totalGrossPence - t.paid - t.credit,
    etaDate: o.etaDate,
    etaReason: o.etaReason,
    actionUrl,
    journey: journeyFor(o.specificationJson),
    fit: fitSpec(o.specificationJson),
  };
}

/**
 * Creates the order (and customer if new) on the order pad as "To place", and records any deposit.
 * The customer isn't emailed yet: they hear from us when the order is placed with the supplier.
 */
export async function createOrder(ctx: Ctx, raw: unknown) {
  if (!ctx.userId) throw new ServiceError('Orders must be taken by a signed-in staff member.');
  const input = parse(orderCreateSchema, raw);

  const order = await withTenant(ctx.org.id, async (tx) => {
    const customer = await findOrCreateCustomer(tx, ctx, { name: input.customerName, email: input.email, phone: input.phone, customerId: input.customerId });
    const orderNumber = await nextNumber(tx, ctx.org.id, 'order');
    const [order] = await tx
      .insert(orders)
      .values({
        organisationId: ctx.org.id,
        orderNumber,
        customerId: customer.id,
        status: 'place_order',
        brand: input.brand,
        category: input.category,
        product: input.product,
        sku: input.sku,
        supplier: input.brand,
        specificationText: composeSpec({ ...input, notes: input.specificationText }),
        totalGrossPence: input.totalGrossPence,
        etaDate: input.etaDate,
        supplierReference: input.supplierReference,
        internalNotes: input.internalNotes,
        takenByUserId: ctx.userId!,
      })
      .returning();

    await recordEvent(tx, {
      organisationId: ctx.org.id,
      actor: ctx.actor,
      eventType: 'order_created',
      entityType: 'order',
      orderId: order.id,
      customerId: customer.id,
      newValue: {
        orderNumber,
        status: order.status,
        brand: order.brand,
        product: order.product,
        sku: order.sku,
        specificationText: order.specificationText,
        totalGrossPence: order.totalGrossPence,
        etaDate: order.etaDate,
        supplierReference: order.supplierReference,
        takenByUserId: order.takenByUserId,
      },
    });

    if (input.creditPence > 0) {
      await insertPayment(tx, ctx, order.id, { kind: 'credit', amountPence: input.creditPence, method: 'account', reference: 'Till account credit' });
    }
    if (input.depositPence > 0) {
      await insertPayment(tx, ctx, order.id, { kind: 'deposit', amountPence: input.depositPence, method: input.depositMethod, reference: '' });
    }

    return order;
  });
  return order;
}

function actorName(ctx: Ctx) {
  return ctx.actor.type === 'user' ? ctx.actor.name : 'COS';
}

async function insertPayment(
  tx: DB,
  ctx: Ctx,
  orderId: string,
  p: { kind: (typeof payments.$inferInsert)['kind']; amountPence: number; method: (typeof payments.$inferInsert)['method']; reference: string },
) {
  if (!ctx.userId) throw new ServiceError('Payments must be recorded by a signed-in staff member.');
  const [row] = await tx
    .insert(payments)
    .values({ organisationId: ctx.org.id, orderId, recordedByUserId: ctx.userId, ...p })
    .returning();
  await recordEvent(tx, {
    organisationId: ctx.org.id,
    actor: ctx.actor,
    eventType: 'payment_recorded',
    entityType: 'order',
    orderId,
    newValue: { paymentId: row.id, kind: row.kind, amountPence: row.amountPence, method: row.method, reference: row.reference },
  });
  return row;
}

/**
 * Status / ETA / supplier reference changes from the order panel.
 * Triggers the ETA-revised and ready-for-collection automations.
 */
export async function updateOrderProgress(ctx: Ctx, orderId: string, raw: unknown) {
  const input = parse(orderUpdateSchema, raw);
  const notify = input.notify || !atLeast(ctx, 'manager');

  const messageIds = await withTenant(ctx.org.id, async (tx) => {
    const { order, customer } = await loadOrder(tx, ctx, orderId);
    if (order.archivedAt) throw new ServiceError('Restore this order before changing it.');
    const ids: (string | null)[] = [];
    const patch: Partial<typeof orders.$inferInsert> = {};
    const now = new Date();
    const base = { organisationId: ctx.org.id, actor: ctx.actor, entityType: 'order' as const, orderId, customerId: customer.id };

    // Supplier reference
    if (input.supplierReference !== order.supplierReference) {
      patch.supplierReference = input.supplierReference;
      await recordEvent(tx, {
        ...base,
        eventType: 'supplier_reference_changed',
        oldValue: { supplierReference: order.supplierReference },
        newValue: { supplierReference: input.supplierReference },
      });
    }

    // Status
    const statusChanged = input.status !== order.status;
    // Placing = leaving the order pad: in stock (with an ETA) or out of stock at the supplier.
    const placing = statusChanged && order.status === 'place_order' && (input.status === 'ordered' || input.status === 'delayed');
    if (placing && input.status === 'ordered' && !input.etaDate) {
      throw new ServiceError('Add the estimated arrival date: the customer’s confirmation email tells them when to expect it.', {
        etaDate: 'Required when placing the order',
      });
    }
    if (statusChanged) {
      if (!canTransition(order.status, input.status)) {
        throw new ServiceError(`An order cannot move from ${statusLabel(order.status)} to ${statusLabel(input.status)}.`, {
          status: 'Choose a valid next step',
        });
      }
      if (order.status === 'collected') requireRole(ctx, 'manager', 're-open a collected order');
      patch.status = input.status;
      patch.statusChangedAt = now;
      let balance = 0;
      if (input.status === 'collected') {
        balance = order.totalGrossPence - (await paidPence(tx, orderId));
        if (ctx.org.paymentTracking && balance > 0 && !input.collectWithBalance) {
          throw new ServiceError(
            `This order still has a balance outstanding. Record the payment first, or confirm collection with a balance outstanding.`,
            { collectWithBalance: 'Confirm to collect with a balance outstanding' },
          );
        }
        patch.collectedAt = now;
      }
      if (input.status === 'ready') patch.readyAt = now;
      await recordEvent(tx, {
        ...base,
        eventType: input.status === 'ready' ? 'order_ready' : input.status === 'collected' ? 'order_collected' : 'status_changed',
        oldValue: { status: order.status },
        newValue: { status: input.status },
        metadata: input.status === 'collected' ? { balanceOutstandingPence: Math.max(balance, 0) } : undefined,
      });
    }

    // ETA
    const etaChanged = input.etaDate !== order.etaDate;
    if (etaChanged || (input.etaReason && input.etaReason !== order.etaReason)) {
      patch.etaDate = input.etaDate;
      patch.etaReason = input.etaReason;
      if (etaChanged) {
        await recordEvent(tx, {
          ...base,
          eventType: 'eta_changed',
          oldValue: { etaDate: order.etaDate },
          newValue: { etaDate: input.etaDate, etaReason: input.etaReason },
        });
      }
    }

    if (Object.keys(patch).length === 0) return ids;
    patch.updatedAt = now;
    const [updated] = await tx.update(orders).set(patch).where(eq(orders.id, orderId)).returning();

    // Customer notifications: placed (with ETA, or out of stock), then only delays/ETA changes and arrival.
    // Nothing is sent while an order is still on the order pad: the customer hasn't been told anything yet.
    const willBeReady = statusChanged && input.status === 'ready';
    const becameDelayed = statusChanged && input.status === 'delayed';
    const onPad = updated.status === 'place_order';
    if (willBeReady || placing || ((etaChanged || becameDelayed) && !onPad && updated.status !== 'collected')) {
      const totals = await paymentTotals(tx, orderId);
      const link = await issueTrackingLink(tx, ctx.org.id, orderId);
      const ctxEmail = orderEmailContext(updated, customer, totals, link);
      const suppressedBy = notify ? null : actorName(ctx);
      if (willBeReady) {
        ids.push(
          await enqueueEmail(tx, {
            org: ctx.org, template: 'ready_for_collection', recipient: customer.email, customerId: customer.id,
            orderId, context: ctxEmail, actor: ctx.actor, suppressedBy,
          }),
        );
      } else if (placing) {
        ids.push(
          await enqueueEmail(tx, {
            org: ctx.org, template: 'order_confirmation', recipient: customer.email, customerId: customer.id, orderId,
            context: { ...ctxEmail, outOfStock: input.status === 'delayed' }, actor: ctx.actor, suppressedBy,
          }),
        );
      } else {
        ids.push(
          await enqueueEmail(tx, {
            org: ctx.org, template: 'eta_revised', recipient: customer.email, customerId: customer.id, orderId,
            context: { ...ctxEmail, previousEtaDate: etaChanged ? order.etaDate : null },
            actor: ctx.actor, suppressedBy,
          }),
        );
      }
    }
    return ids;
  });

  await dispatchMessages(ctx.org, messageIds);
}

/** Product, specification, price and notes. Each change is diffed onto the ledger. */
export async function editOrderDetails(ctx: Ctx, orderId: string, raw: unknown) {
  const input = parse(orderEditSchema, raw);
  await withTenant(ctx.org.id, async (tx) => {
    const { order } = await loadOrder(tx, ctx, orderId);
    if (order.archivedAt) throw new ServiceError('Restore this order before changing it.');
    const keys = ['brand', 'category', 'product', 'sku', 'totalGrossPence', 'supplier', 'supplierNotes', 'internalNotes'] as const;
    const oldV: Record<string, unknown> = {};
    const newV: Record<string, unknown> = {};
    for (const k of keys) {
      if (input[k] !== order[k]) {
        oldV[k] = order[k];
        newV[k] = input[k];
      }
    }
    const specChanged = input.specificationText !== order.specificationText;
    if (!specChanged && Object.keys(newV).length === 0) return;
    await tx
      .update(orders)
      .set({ ...newV, ...(specChanged ? { specificationText: input.specificationText } : {}), updatedAt: new Date() })
      .where(eq(orders.id, orderId));
    const base = { organisationId: ctx.org.id, actor: ctx.actor, entityType: 'order' as const, orderId, customerId: order.customerId };
    if (specChanged) {
      await recordEvent(tx, {
        ...base,
        eventType: 'specification_changed',
        oldValue: { specificationText: order.specificationText },
        newValue: { specificationText: input.specificationText },
      });
    }
    if (Object.keys(newV).length) {
      await recordEvent(tx, { ...base, eventType: 'order_details_changed', oldValue: oldV, newValue: newV });
    }
  });
}

export async function recordPayment(ctx: Ctx, orderId: string, raw: unknown) {
  const input = parse(paymentSchema, raw);
  if (input.kind === 'refund') requireRole(ctx, 'manager', 'record a refund or correction');
  await withTenant(ctx.org.id, async (tx) => {
    const { order } = await loadOrder(tx, ctx, orderId);
    if (order.archivedAt) throw new ServiceError('Restore this order before recording payments.');
    const paid = await paidPence(tx, orderId);
    if (input.kind === 'refund' && input.amountPence > paid) {
      throw new ServiceError('A refund cannot exceed the amount paid.', { amountPence: `Maximum refund is £${(paid / 100).toFixed(2)}` });
    }
    await insertPayment(tx, ctx, orderId, input.kind === 'credit' ? { ...input, method: 'account' } : input);
  });
}

/**
 * Voids a payment recorded by mistake. Payments are append-only, so nothing is edited or erased:
 * a 'void' entry is added that cancels it, the original stays visible (struck through) with who
 * voided it and why, and balances ignore it.
 */
export async function voidPayment(ctx: Ctx, orderId: string, paymentId: string, rawReason: unknown) {
  requireRole(ctx, 'manager', 'void payments');
  if (!ctx.userId) throw new ServiceError('Payments must be voided by a signed-in staff member.');
  const reason = String(rawReason ?? '').trim().slice(0, 120);
  if (!reason) throw new ServiceError('Say why it’s being voided, e.g. “Entered twice”.', { reason: 'Required' });
  await withTenant(ctx.org.id, async (tx) => {
    const { order } = await loadOrder(tx, ctx, orderId);
    if (order.removedAt) throw new ServiceError('This order was deleted. Restore it first.');
    const [p] = await tx.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.orderId, orderId))).limit(1);
    if (!p) throw new ServiceError('Payment not found.');
    if (p.kind === 'void') throw new ServiceError('That entry is itself a void.');
    const [already] = await tx.select({ id: payments.id }).from(payments).where(eq(payments.voidsPaymentId, paymentId)).limit(1);
    if (already) throw new ServiceError('That payment has already been voided.');
    const [v] = await tx
      .insert(payments)
      .values({ organisationId: ctx.org.id, orderId, kind: 'void', amountPence: p.amountPence, method: p.method, reference: reason, recordedByUserId: ctx.userId!, voidsPaymentId: p.id })
      .returning();
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'payment_voided', entityType: 'order', orderId, customerId: order.customerId,
      oldValue: { paymentId: p.id, kind: p.kind, amountPence: p.amountPence, method: p.method }, newValue: { voidId: v.id, reason },
    });
  });
}

/**
 * Deletes (or restores) a note on an order. The timeline is append-only, so the note itself is never
 * erased: a 'note_deleted' entry hides it from the timeline. The note's author or a manager can do this.
 */
export async function setNoteDeleted(ctx: Ctx, orderId: string, noteEventId: string, deleted: boolean) {
  await withTenant(ctx.org.id, async (tx) => {
    const { order } = await loadOrder(tx, ctx, orderId);
    const [note] = await tx
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.id, noteEventId), eq(auditEvents.orderId, orderId), eq(auditEvents.eventType, 'note_added')))
      .limit(1);
    if (!note) throw new ServiceError('Note not found.');
    if (note.actorUserId !== ctx.userId) requireRole(ctx, 'manager', deleted ? "delete another staff member's note" : "restore another staff member's note");
    const state = await noteDeletedState(tx, noteEventId);
    if (state === deleted) return;
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: deleted ? 'note_deleted' : 'note_restored', entityType: 'order',
      orderId, customerId: order.customerId, metadata: { noteEventId },
    });
  });
}

/** Whether a note is currently deleted: the latest delete/restore entry for it wins. */
async function noteDeletedState(tx: DB, noteEventId: string) {
  const [last] = await tx
    .select({ type: auditEvents.eventType })
    .from(auditEvents)
    .where(and(inArray(auditEvents.eventType, ['note_deleted', 'note_restored']), sql`${auditEvents.metadataJson}->>'noteEventId' = ${noteEventId}`))
    .orderBy(desc(auditEvents.createdAt))
    .limit(1);
  return last?.type === 'note_deleted';
}

export async function addNote(ctx: Ctx, orderId: string, raw: unknown) {
  const { note } = parse(noteSchema, raw);
  await withTenant(ctx.org.id, async (tx) => {
    const { order } = await loadOrder(tx, ctx, orderId);
    await recordEvent(tx, {
      organisationId: ctx.org.id,
      actor: ctx.actor,
      eventType: 'note_added',
      entityType: 'order',
      orderId,
      customerId: order.customerId,
      newValue: { note },
    });
  });
}

/**
 * Deletes an order entered by mistake (or restores it). Nothing is erased: it's archived and also
 * left out of the Archived list, the customer's history, Performance and exports. Orders with
 * money recorded against them can't be deleted (archive them, or refund first).
 */
export async function setOrderDeleted(ctx: Ctx, orderId: string, deleted: boolean) {
  requireRole(ctx, 'manager', deleted ? 'delete orders' : 'restore orders');
  await withTenant(ctx.org.id, async (tx) => {
    const { order } = await loadOrder(tx, ctx, orderId);
    if (Boolean(order.removedAt) === deleted) return;
    if (deleted) {
      const paid = await paidPence(tx, orderId);
      if (paid !== 0) {
        throw new ServiceError(`This order has ${money(paid)} in payments recorded, so it can’t be deleted. Archive it instead, or record the refund first.`);
      }
    }
    const now = new Date();
    // Restoring returns it to how it was: archived only if it was archived before it was deleted.
    const wasArchivedBefore = order.archivedAt && order.removedAt && order.archivedAt.getTime() !== order.removedAt.getTime();
    await tx
      .update(orders)
      .set(deleted ? { removedAt: now, archivedAt: order.archivedAt ?? now, updatedAt: now } : { removedAt: null, archivedAt: wasArchivedBefore ? order.archivedAt : null, updatedAt: now })
      .where(eq(orders.id, orderId));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: deleted ? 'order_deleted' : 'order_undeleted', entityType: 'order',
      orderId, customerId: order.customerId, newValue: { orderNumber: order.orderNumber },
    });
  });
}

export async function listDeletedOrders(orgId: string) {
  return withTenant(orgId, (tx) =>
    tx
      .select({ id: orders.id, orderNumber: orders.orderNumber, brand: orders.brand, product: orders.product, removedAt: orders.removedAt, customer: customers.name })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(isNotNull(orders.removedAt))
      .orderBy(desc(orders.removedAt))
      .limit(50),
  );
}

export async function setArchived(ctx: Ctx, orderId: string, archived: boolean) {
  requireRole(ctx, 'manager', archived ? 'archive orders' : 'restore orders');
  await withTenant(ctx.org.id, async (tx) => {
    const { order } = await loadOrder(tx, ctx, orderId);
    if (order.removedAt) throw new ServiceError('This order was deleted. Restore it first.');
    if (Boolean(order.archivedAt) === archived) return;
    await tx.update(orders).set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() }).where(eq(orders.id, orderId));
    await recordEvent(tx, {
      organisationId: ctx.org.id,
      actor: ctx.actor,
      eventType: archived ? 'order_archived' : 'order_restored',
      entityType: 'order',
      orderId,
      customerId: order.customerId,
    });
  });
}

export async function createTrackingLink(ctx: Ctx, orderId: string): Promise<string> {
  return withTenant(ctx.org.id, async (tx) => {
    const { order } = await loadOrder(tx, ctx, orderId);
    const url = await issueTrackingLink(tx, ctx.org.id, orderId);
    await recordEvent(tx, {
      organisationId: ctx.org.id,
      actor: ctx.actor,
      eventType: 'tracking_link_created',
      entityType: 'order',
      orderId,
      customerId: order.customerId,
    });
    return url;
  });
}

export async function addAttachment(ctx: Ctx, orderId: string, file: File, rawMeta: unknown) {
  if (!ctx.userId) throw new ServiceError('Sign in to upload files.');
  const meta = parse(attachmentMetaSchema, rawMeta);
  if (!file || file.size === 0) throw new ServiceError('Choose a file to upload.', { file: 'Choose a file' });
  if (file.size > MAX_UPLOAD_BYTES) throw new ServiceError('Files must be 4 MB or smaller.', { file: 'Too large (max 4 MB)' });
  const ext = ALLOWED_UPLOAD_TYPES[file.type];
  if (!ext) throw new ServiceError('That file type is not supported. Upload a PDF, image, CSV, Word or Excel file.', { file: 'Unsupported type' });

  const filename = file.name.replace(/[^\w.\- ()]/g, '_').slice(0, 150) || `upload.${ext}`;
  const key = `orgs/${ctx.org.id}/orders/${orderId}/${newToken().slice(0, 16)}.${ext}`;

  // Confirm the order belongs to this organisation before writing anything.
  await withTenant(ctx.org.id, (tx) => loadOrder(tx, ctx, orderId));
  await storage().put(key, Buffer.from(await file.arrayBuffer()), file.type);

  await withTenant(ctx.org.id, async (tx) => {
    const [row] = await tx
      .insert(attachments)
      .values({
        organisationId: ctx.org.id,
        orderId,
        storageKey: key,
        filename,
        mimeType: file.type,
        sizeBytes: file.size,
        category: meta.category,
        visibility: meta.visibility,
        uploadedByUserId: ctx.userId!,
      })
      .returning();
    await recordEvent(tx, {
      organisationId: ctx.org.id,
      actor: ctx.actor,
      eventType: 'attachment_added',
      entityType: 'order',
      orderId,
      newValue: { attachmentId: row.id, filename, category: meta.category, visibility: meta.visibility },
    });
  });
}

/** Brings back a deleted attachment (the uploader, or a manager). */
export async function restoreAttachment(ctx: Ctx, attachmentId: string) {
  await withTenant(ctx.org.id, async (tx) => {
    const [a] = await tx.select().from(attachments).where(eq(attachments.id, attachmentId)).limit(1);
    if (!a?.archivedAt) return;
    if (a.uploadedByUserId !== ctx.userId) requireRole(ctx, 'manager', "restore another staff member's attachment");
    await tx.update(attachments).set({ archivedAt: null }).where(eq(attachments.id, attachmentId));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'attachment_restored', entityType: 'order', orderId: a.orderId,
      newValue: { attachmentId: a.id, filename: a.filename },
    });
  });
}

/** Deletes an attachment (kept in storage and restorable; customers can no longer see it). */
export async function archiveAttachment(ctx: Ctx, attachmentId: string) {
  await withTenant(ctx.org.id, async (tx) => {
    const [a] = await tx
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, attachmentId), isNull(attachments.archivedAt)))
      .limit(1);
    if (!a) throw new ServiceError('Attachment not found.');
    if (a.uploadedByUserId !== ctx.userId) requireRole(ctx, 'manager', "delete another staff member's attachment");
    await tx.update(attachments).set({ archivedAt: new Date() }).where(eq(attachments.id, attachmentId));
    await recordEvent(tx, {
      organisationId: ctx.org.id,
      actor: ctx.actor,
      eventType: 'attachment_archived',
      entityType: 'order',
      orderId: a.orderId,
      oldValue: { attachmentId: a.id, filename: a.filename },
    });
  });
}
