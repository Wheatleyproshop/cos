import Link from 'next/link';
import { money } from '@/lib/format';
import type { inHouseWork } from '@/lib/services/online-designs';
import { QUOTE_STATUS_LABELS } from '@/lib/status';
import { OrderNextStep, QuoteNextStep } from './next-steps';

type Work = Awaited<ReturnType<typeof inHouseWork>>;

const JOB_STATUS: Record<string, string> = { place_order: 'Approved', ordered: 'In production', delayed: 'Delayed', ready: 'Ready to collect' };

/** Proofs waiting on the customer and approved jobs not yet collected, each with its next-step buttons. */
export function InHouseWork({
  work, paymentTracking, ready, what,
}: {
  work: Work;
  paymentTracking: boolean;
  ready: { text: string; verb: string };
  what: { proofs: string; jobs: string };
}) {
  if (!work.proofs.length && !work.jobs.length) return null;
  return (
    <div className="split inhouse">
      <section className="panel">
        <h2>
          {what.proofs} · {work.proofs.length}
        </h2>
        {work.proofs.length ? (
          <ul className="attention">
            {work.proofs.map(({ q, customer, email, online }) => (
              <li key={q.id}>
                <span>
                  <Link href={`/quotes/${q.quoteNumber}`} className="rowtitle" scroll={false}>
                    {customer} · {q.product}
                  </Link>
                  <div className="muted">
                    {q.quoteNumber} · {QUOTE_STATUS_LABELS[q.status]}
                    {online ? <span className="pill" style={{ marginLeft: 6 }}>Designed online</span> : null} · {money(q.totalGrossPence)}
                  </div>
                </span>
                <QuoteNextStep q={q} customerName={customer} email={email} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing waiting for approval.</p>
        )}
      </section>
      <section className="panel">
        <h2>
          {what.jobs} · {work.jobs.length}
        </h2>
        {work.jobs.length ? (
          <ul className="attention">
            {work.jobs.map(({ o, customer, balance }) => {
              const owed = paymentTracking && balance > 0 ? money(balance) : null;
              return (
                <li key={o.id}>
                  <span>
                    <Link href={`/orders/${o.orderNumber}`} className="rowtitle" scroll={false}>
                      {customer} · {o.product}
                    </Link>
                    <div className="muted">
                      {o.orderNumber} · {JOB_STATUS[o.status] ?? o.status}
                      {owed && o.status === 'ready' ? ` · ${owed} to pay` : ` · ${money(o.totalGrossPence)}`}
                    </div>
                  </span>
                  <OrderNextStep o={o} owed={owed} ready={ready} />
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted">Nothing in production.</p>
        )}
      </section>
    </div>
  );
}
