import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionButton } from '@/components/forms';
import { AccountForm } from '@/components/prebook-forms';
import { PageHeader } from '@/components/views';
import { hasRole, requireStaff } from '@/lib/auth';
import { money } from '@/lib/format';
import { listAccounts, type AccountRow } from '@/lib/services/accounts';
import { accountActiveAction, catalogueAccountsAction, saveAccountAction } from '../actions';

export const metadata: Metadata = { title: 'Accounts' };

const tel = (n: string) => `tel:${n.replace(/[^\d+]/g, '')}`;

function Contact({ label, value, href }: { label: string; value: string; href?: string }) {
  if (!value) return null;
  return (
    <div className="acct-row">
      <small>{label}</small>
      {href ? (
        <a href={href} target={href.startsWith('http') ? '_blank' : undefined} rel={href.startsWith('http') ? 'noopener noreferrer' : undefined}>
          {value}
        </a>
      ) : (
        <span>{value}</span>
      )}
    </div>
  );
}

function AccountCard({ a, manager }: { a: AccountRow; manager: boolean }) {
  const empty = !a.accountNumber && !a.repName && !a.repPhone && !a.repEmail && !a.headOfficePhone && !a.headOfficeEmail;
  return (
    <article className="panel acct" id={`acct-${a.id}`} style={a.active ? undefined : { opacity: 0.6 }}>
      <header className="acct-head">
        <div>
          <h2>{a.brand}</h2>
          <div className="muted">{a.accountNumber ? `Account ${a.accountNumber}` : 'No account number yet'}</div>
        </div>
        {a.openPrebooks ? (
          <Link href={`/prebook?brand=${encodeURIComponent(a.brand)}`} className="pill">
            {a.openPrebooks} open pre-book{a.openPrebooks === 1 ? '' : 's'} · {money(a.openValuePence)}
          </Link>
        ) : null}
      </header>

      {empty ? <p className="muted">No details yet.{manager ? ' Use “Edit details” to add the rep, head office and account number.' : ''}</p> : null}

      <div className="acct-grid">
        {a.repName || a.repPhone || a.repEmail ? (
          <section>
            <h3>Your rep</h3>
            <Contact label="Name" value={a.repName} />
            <Contact label="Mobile" value={a.repPhone} href={a.repPhone ? tel(a.repPhone) : undefined} />
            <Contact label="Email" value={a.repEmail} href={a.repEmail ? `mailto:${a.repEmail}` : undefined} />
          </section>
        ) : null}
        {a.headOfficePhone || a.headOfficeEmail || a.ordersEmail ? (
          <section>
            <h3>Head office</h3>
            <Contact label="Phone" value={a.headOfficePhone} href={a.headOfficePhone ? tel(a.headOfficePhone) : undefined} />
            <Contact label="Email" value={a.headOfficeEmail} href={a.headOfficeEmail ? `mailto:${a.headOfficeEmail}` : undefined} />
            <Contact label="Orders / customer services" value={a.ordersEmail} href={a.ordersEmail ? `mailto:${a.ordersEmail}` : undefined} />
          </section>
        ) : null}
        {a.portalUrl || a.portalUsername || a.paymentTerms ? (
          <section>
            <h3>Trading</h3>
            <Contact label="Trade portal" value={a.portalUrl.replace(/^https:\/\//, '')} href={a.portalUrl || undefined} />
            <Contact label="Portal username" value={a.portalUsername} />
            <Contact label="Payment terms" value={a.paymentTerms} />
          </section>
        ) : null}
      </div>
      {a.notes ? <p className="acct-notes">{a.notes}</p> : null}

      {manager ? (
        <div className="acct-actions">
          <details className="section">
            <summary>Edit details</summary>
            <AccountForm action={saveAccountAction.bind(null, a.id)} values={a} />
          </details>
          <ActionButton action={accountActiveAction.bind(null, a.id, !a.active)} className="btn small">
            {a.active ? 'Hide account' : 'Restore'}
          </ActionButton>
        </div>
      ) : null}
    </article>
  );
}

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ hidden?: string }> }) {
  const staff = await requireStaff();
  const manager = hasRole(staff, 'manager');
  const { hidden } = await searchParams;
  const accounts = await listAccounts(staff.organisationId, { includeInactive: hidden === '1' });
  return (
    <>
      <PageHeader
        staff={staff}
        title="Accounts."
        sub="Your trade accounts: account numbers, reps and head office contacts for every brand you deal with."
        actions={
          <Link href={hidden === '1' ? '/accounts' : '/accounts?hidden=1'} className="btn">
            {hidden === '1' ? 'Hide hidden accounts' : 'Show hidden accounts'}
          </Link>
        }
      />
      {!accounts.length ? (
        <div className="panel empty">
          <p>No accounts yet.</p>
          {manager ? (
            <ActionButton action={catalogueAccountsAction} className="btn primary">
              Add a card for each catalogue brand
            </ActionButton>
          ) : null}
        </div>
      ) : null}
      <div className="acct-list">
        {accounts.map((a) => (
          <AccountCard key={a.id} a={a} manager={manager} />
        ))}
      </div>
      {manager ? (
        <section className="panel" style={{ marginTop: 18 }}>
          <details className="section" open={!accounts.length}>
            <summary>Add an account</summary>
            <AccountForm action={saveAccountAction.bind(null, null)} submitLabel="Add account" />
          </details>
          {accounts.length ? (
            <div style={{ marginTop: 10 }}>
              <ActionButton action={catalogueAccountsAction} className="btn small">
                Add cards for any catalogue brands missing
              </ActionButton>
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
