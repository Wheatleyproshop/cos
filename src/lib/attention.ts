import type { Order, Organisation, Quote } from '@/db/schema';
import { daysBetween, niceDate } from './format';

export type AttentionFlag = {
  code: 'eta_passed' | 'delayed' | 'uncollected' | 'missing_supplier_ref' | 'quote_awaiting';
  label: string;
};

type Thresholds = Pick<Organisation, 'readyUncollectedDays' | 'quoteFollowupDays' | 'missingSupplierRefDays'>;

export function orderAttention(
  o: Pick<Order, 'status' | 'etaDate' | 'readyAt' | 'createdAt' | 'supplierReference' | 'archivedAt'>,
  t: Thresholds,
  today: string,
  now = new Date(),
): AttentionFlag[] {
  if (o.archivedAt || o.status === 'collected') return [];
  const flags: AttentionFlag[] = [];
  if (o.etaDate && o.etaDate < today && o.status !== 'ready') {
    flags.push({ code: 'eta_passed', label: `ETA passed (${niceDate(o.etaDate)})` });
  }
  if (o.status === 'delayed') flags.push({ code: 'delayed', label: 'Delayed at supplier' });
  if (o.status === 'ready' && o.readyAt) {
    const days = daysBetween(new Date(o.readyAt), now);
    if (days >= t.readyUncollectedDays) flags.push({ code: 'uncollected', label: `Ready but uncollected for ${days} days` });
  }
  if (['place_order', 'ordered', 'delayed'].includes(o.status) && !o.supplierReference.trim()) {
    const days = daysBetween(new Date(o.createdAt), now);
    if (days >= t.missingSupplierRefDays) flags.push({ code: 'missing_supplier_ref', label: `No supplier reference after ${days} days` });
  }
  return flags;
}

export function quoteAttention(q: Pick<Quote, 'status' | 'sentAt' | 'archivedAt'>, t: Thresholds, now = new Date()): AttentionFlag[] {
  if (q.archivedAt || q.status !== 'sent' || !q.sentAt) return [];
  const days = daysBetween(new Date(q.sentAt), now);
  return days >= t.quoteFollowupDays ? [{ code: 'quote_awaiting', label: `Awaiting customer response for ${days} days` }] : [];
}
