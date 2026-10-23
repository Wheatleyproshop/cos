import Link from 'next/link';
import type { FormState } from '@/lib/action-utils';
import { money, stamp } from '@/lib/format';
import { CopyLink } from './copy-link';
import { ActionButton } from './forms';

type Submitted = { quoteNumber: string; product: string; brand: string; totalGrossPence: number; createdAt: Date; customer: string };

/** Online designs waiting for the shop to review. */
export function SubmittedDesigns({ rows, tz, what }: { rows: Submitted[]; tz: string; what: string }) {
  if (!rows.length) return null;
  return (
    <section className="panel">
      <h2>
        {what} sent in by customers · {rows.length} to review
      </h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Open one to check the artwork, then approve it in store, or edit it and email a proof back.
      </p>
      <ul className="attention">
        {rows.map((d) => (
          <li key={d.quoteNumber}>
            <span>
              <Link href={`/quotes/${d.quoteNumber}`} className="rowtitle">
                {d.customer} · {d.brand} {d.product}
              </Link>
              <div className="muted">
                {d.quoteNumber} · sent {stamp(d.createdAt, tz)}
              </div>
            </span>
            <span className="muted">{money(d.totalGrossPence)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The shareable public link, with an on/off switch for managers. */
export function DesignLinkPanel({
  url, on, manager, toggle, what,
}: {
  url: string;
  on: boolean;
  manager: boolean;
  toggle: () => Promise<FormState>;
  what: string;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Customer design link</h2>
        <span className={`badge ${on ? 'ready' : 'pb-cancelled'}`}>{on ? 'On' : 'Off'}</span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {on
          ? `Share this on your website, socials or by email. Customers design their own ${what} and send them to you to check. You’ll get an email and a notification for each one.`
          : 'Switched off: customers who open the link are asked to contact the shop.'}
      </p>
      {on ? <CopyLink url={url} label="Customer design link" /> : null}
      {manager ? (
        <div style={{ marginTop: 10 }}>
          <ActionButton action={toggle} className="btn small">
            {on ? 'Switch link off' : 'Switch link on'}
          </ActionButton>
        </div>
      ) : null}
    </section>
  );
}
