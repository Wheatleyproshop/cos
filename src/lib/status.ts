import type { OrderStatus, QuoteStatus } from '@/db/schema';

/**
 * Default COS workflow: Quote → Place order → Ordered → (Delayed) → Ready for collection → Collected.
 *
 * The workflow is data, not scattered conditionals, so a future per-organisation
 * workflow (e.g. adding Approved / In production / Dispatched) only needs a new
 * definition of this shape.
 */
export type WorkflowStep = {
  key: OrderStatus;
  label: string;
  /** Shown to customers on the tracking page. */
  customerLabel: string;
  tone: 'neutral' | 'progress' | 'warning' | 'success' | 'done';
  /** Counts toward "awaiting supplier". */
  awaitingSupplier: boolean;
  terminal: boolean;
  next: OrderStatus[];
};

export const DEFAULT_WORKFLOW: WorkflowStep[] = [
  {
    key: 'place_order',
    // On the order pad: taken from the customer, not yet placed with the supplier (no customer email yet).
    label: 'To place',
    customerLabel: 'Order received',
    tone: 'neutral',
    awaitingSupplier: true,
    terminal: false,
    next: ['ordered', 'delayed', 'ready'],
  },
  {
    key: 'ordered',
    label: 'Placed',
    customerLabel: 'Placed with manufacturer',
    tone: 'progress',
    awaitingSupplier: true,
    terminal: false,
    next: ['delayed', 'ready', 'place_order'],
  },
  {
    key: 'delayed',
    label: 'Out of stock / delayed',
    customerLabel: 'Delayed at manufacturer',
    tone: 'warning',
    awaitingSupplier: true,
    terminal: false,
    next: ['ordered', 'ready'],
  },
  {
    key: 'ready',
    label: 'Ready for collection',
    customerLabel: 'Arrived in store',
    tone: 'success',
    awaitingSupplier: false,
    terminal: false,
    next: ['collected', 'ordered'],
  },
  {
    key: 'collected',
    label: 'Collected',
    customerLabel: 'Collected',
    tone: 'done',
    awaitingSupplier: false,
    terminal: true,
    // Re-opening a collected order is a manager-only correction.
    next: ['ready'],
  },
];

const byKey = new Map(DEFAULT_WORKFLOW.map((s) => [s.key, s]));

export function step(status: OrderStatus): WorkflowStep {
  return byKey.get(status) ?? DEFAULT_WORKFLOW[0];
}

export function statusLabel(status: OrderStatus): string {
  return step(status).label;
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return from === to || step(from).next.includes(to);
}

export const ACTIVE_STATUSES: OrderStatus[] = DEFAULT_WORKFLOW.filter((s) => !s.terminal).map((s) => s.key);

export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: 'Quote · draft',
  sent: 'Quote',
  accepted: 'Quote accepted',
  declined: 'Quote declined',
  expired: 'Quote expired',
  cancelled: 'Quote cancelled',
};

export function badgeClass(status: OrderStatus | 'quote'): string {
  if (status === 'quote') return 'badge quoted';
  const tone = step(status).tone;
  return tone === 'success' ? 'badge ready' : tone === 'warning' ? 'badge delayed' : tone === 'progress' ? 'badge progress' : 'badge';
}

/**
 * What the customer is told depends on how the order is fulfilled: club orders go to the
 * manufacturer; personalised balls come from stock and go to the printer.
 */
export type Journey = 'supplier' | 'print' | 'cresting';

export function journeyFor(specificationJson: unknown): Journey {
  const kind = (specificationJson as { kind?: string } | null)?.kind;
  return kind === 'cos-ball-print' ? 'print' : kind === 'cos-cresting' ? 'cresting' : 'supplier';
}

/** Made in-house (printing, cresting): goes straight into production when the proof is approved. */
export const inHouse = (j: Journey) => j !== 'supplier';

export const JOURNEY_WORDS: Record<
  Journey,
  { placed: string; delayed: string; ready: string; readyLong: string; created: (store: string) => string; etaLabel: string; doneValue: string }
> = {
  supplier: {
    placed: 'Placed with manufacturer',
    delayed: 'Delayed at manufacturer',
    ready: 'Arrived in store',
    readyLong: 'Arrived in store — ready to collect',
    created: (store) => `Order received by ${store}`,
    etaLabel: 'Estimated arrival',
    doneValue: 'In store',
  },
  print: {
    placed: 'Sent for printing',
    delayed: 'Delayed at the printer',
    ready: 'Ready to collect',
    readyLong: 'Printed — ready to collect',
    created: (store) => `Proof approved — order placed with ${store} and sent for printing`,
    etaLabel: 'Estimated ready date',
    doneValue: 'Ready in store',
  },
  cresting: {
    placed: 'In production',
    delayed: 'Delayed in production',
    ready: 'Ready to collect',
    readyLong: 'Crested — ready to collect',
    created: (store) => `Proof approved — order placed with ${store} and gone into production`,
    etaLabel: 'Estimated ready date',
    doneValue: 'Ready in store',
  },
};
