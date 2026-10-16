import type { Organisation, OrderStatus } from '@/db/schema';
import { longDate, money, niceDate, stamp } from '@/lib/format';
import { step } from '@/lib/status';
import { PublicShell } from './public-shell';

export type TrackingOrder = {
  orderNumber: string; status: OrderStatus; brand: string; product: string; specificationText: string;
  totalGrossPence: number; etaDate: string | null; etaReason: string; createdAt: Date;
};

export type TrackingEvent = { eventType: string; oldValueJson: unknown; newValueJson: unknown; createdAt: Date };

/**
 * Customer-facing progress. "Place order" and "Ordered" are both shown as ordered from the
 * supplier, so customers see: Ordered from supplier → Arrived in store → Collected.
 */
export const STEPS: { key: OrderStatus; label: string }[] = [
  { key: 'ordered', label: 'Ordered from supplier' },
  { key: 'ready', label: 'Arrived in store' },
  { key: 'collected', label: 'Collected' },
];

export function describe(e: { eventType: string; oldValueJson: unknown; newValueJson: unknown }, store: string): string | null {
  const n = (e.newValueJson ?? {}) as Record<string, string>;
  switch (e.eventType) {
    case 'order_created':
      return `Order placed with ${store} and ordered from our supplier`;
    case 'status_changed':
      // Moving between Place order and Ordered is internal: the customer already sees "ordered".
      return n.status === 'place_order' || n.status === 'ordered' ? null : step(n.status as OrderStatus).customerLabel;
    case 'eta_changed':
      return `Estimated arrival updated to ${longDate(n.etaDate)}${n.etaReason ? ` — ${n.etaReason}` : ''}`;
    case 'order_ready':
      return 'Arrived in store — ready to collect';
    case 'order_collected':
      return 'Collected — enjoy!';
    default:
      return null;
  }
}


/** The customer-facing order page. Shared by real tracking links and the shop's preview page. */
export function TrackingView({
  org, order: o, customerName, paid, balance, events, files, token, approved, banner,
}: {
  org: Organisation; order: TrackingOrder; customerName: string; paid: number; balance: number;
  events: TrackingEvent[]; files: { id: string; filename: string }[]; token: string | null; approved?: boolean; banner?: React.ReactNode;
}) {
  const current = o.status === 'delayed' || o.status === 'place_order' ? 'ordered' : o.status;
  const idx = STEPS.findIndex((s) => s.key === current);
  const timeline = events.map((e) => ({ text: describe(e, org.storeName), at: e.createdAt })).filter((e) => e.text);
  const d = { paid, balance, files, customerName };
  return (
    <PublicShell org={org}>
      {banner}
      {approved ? (
        <div className="notice" role="status">
          <b>Thank you — your quote is approved.</b>
          We’ve created your order and emailed you a confirmation. You can bookmark this page to follow its progress.
        </div>
      ) : null}
      <div className="eyebrow">ORDER {o.orderNumber}</div>
      <h1 style={{ fontSize: 26 }}>
        {o.brand} {o.product}
      </h1>
      <p style={{ whiteSpace: 'pre-line', marginTop: 0 }}>{o.specificationText}</p>

      <ol className="steps" aria-label="Order progress">
        {STEPS.map((s, i) => (
          <li key={s.key} className={i < idx ? 'done' : i === idx ? 'current' : ''} aria-current={i === idx ? 'step' : undefined}>
            {s.label}
            {s.key === 'ordered' && o.status === 'delayed' ? ' — delayed at supplier' : ''}
          </li>
        ))}
      </ol>

      <div className="detailgrid">
        <div className="detailbox">
          <small>{o.status === 'ready' || o.status === 'collected' ? 'Arrived' : 'Estimated arrival'}</small>
          <b>{o.status === 'ready' || o.status === 'collected' ? 'In store' : o.etaDate ? longDate(o.etaDate) : 'To be confirmed'}</b>
          {o.etaReason && o.status === 'delayed' ? <div className="muted">{o.etaReason}</div> : null}
        </div>
        <div className="detailbox">
          <small>Order total / Paid</small>
          <b>
            {money(o.totalGrossPence)} / {money(d.paid)}
          </b>
          <div className="muted">{d.balance > 0 ? `Balance due on collection: ${money(d.balance)}` : 'Paid in full'}</div>
        </div>
      </div>
      {o.status === 'ready' && org.collectionLocation ? (
        <div className="notice">
          <b>Arrived in store — ready to collect</b>
          {org.collectionLocation}
          {org.openingHours ? ` · ${org.openingHours}` : ''}
        </div>
      ) : null}

      {d.files.length ? (
        <>
          <h3>Documents</h3>
          <ul>
            {d.files.map((f) => (
              <li key={f.id}>
                <a href={token ? `/api/public/attachments/${token}/${f.id}` : '#'} target="_blank" rel="noopener">
                  {f.filename}
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h3>Updates</h3>
      <ol className="timeline">
        {timeline
          .slice()
          .reverse()
          .map((e, i) => (
            <li key={i}>
              <div>{e.text}</div>
              <div className="when">{stamp(e.at, org.timezone)}</div>
            </li>
          ))}
      </ol>
      <p className="muted">Ordered {niceDate(o.createdAt.toISOString().slice(0, 10))}. Hi {d.customerName.split(' ')[0]} — we’ll email you whenever anything changes.</p>
    </PublicShell>
  );
}
