import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CopyLink } from '@/components/copy-link';
import { ActionButton } from '@/components/forms';
import { TeamSetupForm } from '@/components/team-setup-form';
import { PageHeader } from '@/components/views';
import { hasRole, requireStaff } from '@/lib/auth';
import { money } from '@/lib/format';
import { statusLabel } from '@/lib/status';
import { appUrl } from '@/lib/tokens';
import { DEFAULT_TEAM_TERMS, isOpen, londonToday, MAX_TEAM_ITEMS, teamOrderDetail } from '@/lib/services/team-orders';
import { closeTeamOrderAction, updateTeamOrderAction } from '../actions';

export const metadata: Metadata = { title: 'Team order' };

export default async function TeamOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaff();
  const { id } = await params;
  const d = await teamOrderDetail(staff.organisationId, id);
  if (!d) notFound();
  const { team } = d;
  const open = isOpen(team, londonToday());
  const manager = hasRole(staff, 'manager');
  const url = appUrl(`/team/${team.token}`);
  return (
    <>
      <PageHeader
        staff={staff}
        title={team.title}
        sub={`${[team.teamName, team.brand].filter(Boolean).join(' · ')} — ${team.items.map((i) => `${i.product} ${money(i.pricePence)}`).join(', ')}${team.namePricePence ? `; name +${money(team.namePricePence)} each` : ''}`}
        actions={
          <Link href="/orders/team" className="btn">
            All team orders
          </Link>
        }
      />
      <section className="panel">
        <h2>Link for the team {open ? '' : <span className="muted">(closed)</span>}</h2>
        <CopyLink url={url} label="Team order link" />
        <p className="muted" style={{ marginBottom: 0 }}>
          Send this to the team captain or post it in the team’s group chat. Each person fills it in once, choosing a size for each item they want. Each order lands on the order board as
          “To place” and the customer gets a confirmation email.
          {team.closesOn ? ` Closes at the end of ${team.closesOn.split('-').reverse().join('/')}.` : ''}
        </p>
        {manager ? (
          <div className="actions" style={{ marginTop: 12 }}>
            <ActionButton action={closeTeamOrderAction.bind(null, team.id, open)} confirm={open ? 'Stop this link taking orders?' : undefined}>
              {open ? 'Close the link' : 'Reopen the link'}
            </ActionButton>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="sheet-head">
          <h2 style={{ margin: 0 }}>
            {d.totals.orders} {d.totals.orders === 1 ? 'order' : 'orders'} · {d.totals.garments} items · {money(d.totals.value)}
            {d.totals.named ? <span className="muted"> · {d.totals.named} with names</span> : null}
          </h2>
          {d.totals.orders ? (
            <a className="btn small" href={`/api/export/team/${team.id}`}>
              Download list (CSV)
            </a>
          ) : null}
        </div>
        {d.items.map((it) => (
          <div key={it.id} style={{ marginTop: 14 }}>
            <b>{it.product}</b>
            <span className="muted">
              {' '}
              · {it.total} ordered{it.named ? `, ${it.named} with names` : ''}
            </span>
            <div className="team-tally" aria-label={`${it.product} sizes ordered`}>
              {it.sizes.map((s) => (
                <div key={s.size}>
                  <span className="muted">{s.size}</span>
                  <b>{s.total}</b>
                  {s.named ? <small className="muted">{s.named} named</small> : null}
                </div>
              ))}
            </div>
          </div>
        ))}
        {d.orders.length ? (
          <div className="tablewrap" style={{ marginTop: 16 }}>
            <table className="compact">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Items</th>
                  <th>Name on it</th>
                  <th className="num">Total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {d.orders.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link href={`/orders/${o.orderNumber}`} className="rowtitle">
                        {o.orderNumber}
                      </Link>
                    </td>
                    <td>
                      {o.customer}
                      <div className="muted">{o.email}</div>
                    </td>
                    <td>
                      {o.lines.map((l) => (
                        <div key={l.itemId}>
                          {l.product} · <b>{l.size}</b>
                        </div>
                      ))}
                    </td>
                    <td>{o.printedName || <span className="muted">—</span>}</td>
                    <td className="num">{money(o.totalGrossPence)}</td>
                    <td>{statusLabel(o.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No orders yet.</p>
        )}
      </section>

      {manager ? (
        <details className="panel">
          <summary>
            <b>Edit the details</b>
          </summary>
          <TeamSetupForm action={updateTeamOrderAction.bind(null, team.id)} team={team} defaultTerms={DEFAULT_TEAM_TERMS} max={MAX_TEAM_ITEMS} />
        </details>
      ) : null}
    </>
  );
}
