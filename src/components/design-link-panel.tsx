import type { FormState } from '@/lib/action-utils';
import { CopyLink } from './copy-link';
import { ActionButton } from './forms';

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
