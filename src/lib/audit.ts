import type { DB } from '@/db';
import { auditEvents, type AuditEvent } from '@/db/schema';
import { money, niceDate, titleCase } from './format';
import { statusLabel } from './status';

export type Actor =
  | { type: 'user'; userId: string; name: string }
  | { type: 'system'; label?: string }
  | { type: 'customer'; name: string };

export const SYSTEM: Actor = { type: 'system', label: 'COS' };

export function staffActor(staff: { id: string; name: string }): Actor {
  return { type: 'user', userId: staff.id, name: staff.name };
}

export type EventType =
  | 'order_created'
  | 'order_details_changed'
  | 'status_changed'
  | 'order_ready'
  | 'order_collected'
  | 'eta_changed'
  | 'supplier_reference_changed'
  | 'specification_changed'
  | 'payment_recorded'
  | 'note_added'
  | 'attachment_added'
  | 'attachment_archived'
  | 'tracking_link_created'
  | 'order_archived'
  | 'order_restored'
  | 'quote_created'
  | 'quote_updated'
  | 'quote_sent'
  | 'quote_link_created'
  | 'quote_accepted'
  | 'quote_converted'
  | 'quote_declined'
  | 'quote_cancelled'
  | 'email_queued'
  | 'email_sent'
  | 'email_delivered'
  | 'email_failed'
  | 'email_suppressed'
  | 'customer_created'
  | 'customer_updated'
  | 'settings_changed'
  | 'user_created'
  | 'user_updated'
  | 'data_exported'
  | 'backup_completed'
  | 'backup_failed';

export type EventInput = {
  organisationId: string;
  actor: Actor;
  eventType: EventType;
  entityType: AuditEvent['entityType'];
  entityId?: string | null;
  orderId?: string | null;
  quoteId?: string | null;
  customerId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  metadata?: Record<string, unknown>;
};

/** Appends to the COS Ledger. There is deliberately no update/delete counterpart. */
export async function recordEvent(db: DB, e: EventInput) {
  await db.insert(auditEvents).values({
    organisationId: e.organisationId,
    entityType: e.entityType,
    entityId: e.entityId ?? e.orderId ?? e.quoteId ?? e.customerId ?? null,
    orderId: e.orderId ?? null,
    quoteId: e.quoteId ?? null,
    customerId: e.customerId ?? null,
    actorType: e.actor.type,
    actorUserId: e.actor.type === 'user' ? e.actor.userId : null,
    actorLabel: e.actor.type === 'user' ? e.actor.name : e.actor.type === 'customer' ? `${e.actor.name} (customer)` : (e.actor.label ?? 'COS'),
    eventType: e.eventType,
    oldValueJson: e.oldValue === undefined ? null : (e.oldValue as object),
    newValueJson: e.newValue === undefined ? null : (e.newValue as object),
    metadataJson: e.metadata ?? null,
  });
}

const TEMPLATE_NAMES: Record<string, string> = {
  order_confirmation: 'Order confirmation',
  quote_approval: 'Quote approval',
  eta_revised: 'ETA update',
  ready_for_collection: 'Ready for collection',
  collection_reminder: 'Collection reminder',
};

export function templateName(key: string): string {
  return TEMPLATE_NAMES[key] ?? titleCase(key);
}

type J = Record<string, unknown> | null;

/** Human sentence for the activity timeline. */
export function describeEvent(e: Pick<AuditEvent, 'eventType' | 'oldValueJson' | 'newValueJson' | 'metadataJson'>): string {
  const o = (e.oldValueJson ?? {}) as Record<string, any>;
  const n = (e.newValueJson ?? {}) as Record<string, any>;
  const m = (e.metadataJson ?? {}) as Record<string, any>;
  switch (e.eventType) {
    case 'order_created':
      return m.fromQuote ? `Order created from accepted quote ${m.fromQuote}` : 'Order created';
    case 'status_changed':
      return `Status changed from ${statusLabel(o.status)} to ${statusLabel(n.status)}`;
    case 'order_ready':
      return 'Marked ready for collection';
    case 'order_collected':
      return m.balanceOutstandingPence > 0
        ? `Collected with ${money(m.balanceOutstandingPence)} balance outstanding`
        : 'Collected by customer';
    case 'eta_changed':
      return `ETA changed from ${niceDate(o.etaDate)} to ${niceDate(n.etaDate)}${n.etaReason ? ` — “${n.etaReason}”` : ''}`;
    case 'supplier_reference_changed':
      return o.supplierReference
        ? `Supplier reference changed from ${o.supplierReference} to ${n.supplierReference || '(blank)'}`
        : `Supplier reference added: ${n.supplierReference}`;
    case 'specification_changed':
      return 'Specification changed';
    case 'order_details_changed':
      return `Details updated: ${Object.keys(n).map(fieldLabel).join(', ')}`;
    case 'payment_recorded':
      return n.kind === 'credit'
        ? `Account credit of ${money(n.amountPence)} applied${n.reference ? ` (${n.reference})` : ''}`
        : `${titleCase(n.kind)} of ${money(n.amountPence)} recorded (${titleCase(n.method)}${n.reference ? `, ref ${n.reference}` : ''})`;
    case 'note_added':
      return `Note: ${n.note}`;
    case 'attachment_added':
      return `Attached ${n.filename} (${titleCase(n.category)}, ${n.visibility})`;
    case 'attachment_archived':
      return `Archived attachment ${o.filename}`;
    case 'tracking_link_created':
      return 'Customer tracking link generated';
    case 'order_archived':
      return 'Order archived';
    case 'order_restored':
      return 'Order restored from archive';
    case 'quote_created':
      return 'Quote created';
    case 'quote_updated':
      return `Quote updated: ${Object.keys(n).map(fieldLabel).join(', ')}`;
    case 'quote_sent':
      return 'Quote sent to customer for approval';
    case 'quote_link_created':
      return 'New approval link generated (previous link revoked)';
    case 'quote_accepted':
      return m.recordedByStaff
        ? `Customer approval recorded in store${n.acceptedName ? ` (${n.acceptedName})` : ''}`
        : `Quote approved online${n.acceptedName ? ` by ${n.acceptedName}` : ''}`;
    case 'quote_converted':
      return `Converted to order ${n.orderNumber}`;
    case 'quote_declined':
      return 'Quote declined';
    case 'quote_cancelled':
      return 'Quote cancelled';
    case 'email_queued':
      return `${templateName(m.template)} email queued to ${m.recipient}`;
    case 'email_sent':
      return `${templateName(m.template)} email sent${m.simulated ? ' (simulated — no email provider configured)' : ''}`;
    case 'email_delivered':
      return `${templateName(m.template)} email delivered`;
    case 'email_failed':
      return `${templateName(m.template)} email failed${m.error ? `: ${m.error}` : ''}`;
    case 'email_suppressed':
      return `${templateName(m.template)} email not sent (${m.reason})`;
    case 'customer_created':
      return 'Customer record created';
    case 'customer_updated':
      return `Customer details updated: ${Object.keys(n).map(fieldLabel).join(', ')}`;
    default:
      return titleCase(e.eventType);
  }
}

function fieldLabel(k: string): string {
  const map: Record<string, string> = {
    totalGrossPence: 'total price',
    specificationText: 'specification',
    sku: 'SKU',
    internalNotes: 'internal notes',
    supplierNotes: 'supplier notes',
    depositRequiredPence: 'deposit required',
    estimatedLeadTime: 'lead time',
    validUntil: 'valid until',
  };
  return map[k] ?? titleCase(k.replace(/([A-Z])/g, ' $1').toLowerCase());
}
