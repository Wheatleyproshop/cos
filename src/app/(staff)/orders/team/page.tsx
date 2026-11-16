import type { Metadata } from 'next';
import Link from 'next/link';
import { TeamSetupForm } from '@/components/team-setup-form';
import { PageHeader } from '@/components/views';
import { hasRole, requireStaff } from '@/lib/auth';
import { money } from '@/lib/format';
import { DEFAULT_TEAM_TERMS, isOpen, listTeamOrders, londonToday, MAX_TEAM_ITEMS } from '@/lib/services/team-orders';
import { createTeamOrderAction } from './actions';

export const metadata: Metadata = { title: 'Team orders' };

export default async function TeamOrdersPage() {
  const staff = await requireStaff();
  const list = await listTeamOrders(staff.organisationId);
  const today = londonToday();
  const canSetUp = hasRole(staff, 'manager');
  return (
    <>
      <PageHeader
        staff={staff}
        title="Team orders"
        sub="A link for a team’s kit: each member picks a size for the items they want, adds their name if they want it, and accepts the order. Every response becomes an order."
      />
      <section className="panel">
        {list.length ? (
          <div className="tablewrap">
            <table className="compact">
              <thead>
                <tr>
                  <th>Team order</th>
                  <th>Prices</th>
                  <th className="num">Orders</th>
                  <th className="num">Value</th>
                  <th>Link</th>
                </tr>
              </thead>
              <tbody>
                {list.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link href={`/orders/team/${t.id}`} className="rowtitle">
                        {t.title}
                      </Link>
                      <div className="muted">
                        {[t.teamName, t.items.map((i) => i.product).join(', ')].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td>
                      {t.items.map((i) => money(i.pricePence)).join(' / ')}
                      {t.namePricePence ? <div className="muted">+{money(t.namePricePence)} name</div> : null}
                    </td>
                    <td className="num">{t.count}</td>
                    <td className="num">{money(t.value)}</td>
                    <td>{isOpen(t, today) ? (t.closesOn ? `Open until ${t.closesOn.split('-').reverse().join('/')}` : 'Open') : <span className="muted">Closed</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            No team orders yet.
          </p>
        )}
      </section>
      {canSetUp ? (
        <section className="panel">
          <h2>New team order link</h2>
          <TeamSetupForm action={createTeamOrderAction} defaultTerms={DEFAULT_TEAM_TERMS} max={MAX_TEAM_ITEMS} />
        </section>
      ) : null}
    </>
  );
}
