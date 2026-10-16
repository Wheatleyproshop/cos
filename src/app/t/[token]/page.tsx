import type { Metadata } from 'next';
import { InvalidLink, PublicShell } from '@/components/public-shell';
import { longDate, money, niceDate, stamp } from '@/lib/format';
import { findOrderByTrackingToken } from '@/lib/services/public';
import { step } from '@/lib/status';
import type { OrderStatus } from '@/db/schema';

// Absolute title: customer pages never mention COS.
export const metadata: Metadata = { title: { absolute: 'Your order' }, robots: { index: false } };

const STEPS: { key: OrderStatus; label: string }[] = [
  { key: 'place_order', label: 'Order received' },
  { key: 'ordered', label: 'Ordered from supplier' },
  { key: 'ready', label: 'Ready to collect' },
  { key: 'collected', label: 'Collected' },
];

function describe(e: { eventType: string; oldValueJson: unknown; newValueJson: unknown }, store: string): string | null {
  const n = (e.newValueJson ?? {}) as Record<string, string>;
  switch (e.eventType) {
    case 'order_created':
      return `Order placed with ${store}`;
    case 'status_changed':
      return n.status === 'place_order' ? null : step(n.status as OrderStatus).customerLabel;
    case 'eta_changed':
      return `Estimated arrival updated to ${longDate(n.etaDate)}${n.etaReason ? ` — ${n.etaReason}` : ''}`;
    case 'order_ready':
      return 'Ready to collect';
    case 'order_collected':
      return 'Collected — enjoy!';
    default:
      return null;
  }
}

export default async function TrackingPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ approved?: string }> }) {
  const { token } = await params;
  const { approved } = await searchParams;
  const d = await findOrderByTrackingToken(token);
  if (!d) return <InvalidLink title="This link has expired" body="Please contact the shop and they’ll send you a fresh link to your order." />;
  const { org, order: o } = d;
  const current = o.status === 'delayed' ? 'ordered' : o.status;
  const idx = STEPS.findIndex((s) => s.key === current);
  const timeline = d.events.map((e) => ({ text: describe(e, org.storeName), at: e.createdAt })).filter((e) => e.text);

  return (
    <PublicShell org={org}>
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
          <b>Ready to collect</b>
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
                <a href={`/api/public/attachments/${token}/${f.id}`} target="_blank" rel="noopener">
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
