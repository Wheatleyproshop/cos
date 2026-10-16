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
    label: 'Place order',
    customerLabel: 'Order received',
    tone: 'neutral',
    awaitingSupplier: true,
    terminal: false,
    next: ['ordered', 'delayed', 'ready'],
  },
  {
    key: 'ordered',
    label: 'Ordered',
    customerLabel: 'Ordered from supplier',
    tone: 'progress',
    awaitingSupplier: true,
    terminal: false,
    next: ['delayed', 'ready', 'place_order'],
  },
  {
    key: 'delayed',
    label: 'Delayed',
    customerLabel: 'Delayed at supplier',
    tone: 'warning',
    awaitingSupplier: true,
    terminal: false,
    next: ['ordered', 'ready'],
  },
  {
    key: 'ready',
    label: 'Ready for collection',
    customerLabel: 'Ready to collect',
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
