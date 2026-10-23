import type { Metadata } from 'next';
import Link from 'next/link';
import { CrestPricesForm } from '@/components/cresting-forms';
import { PageHeader } from '@/components/views';
import { hasRole, requireStaff } from '@/lib/auth';
import { CREST_METHODS, CREST_POSITIONS, crestPrices } from '@/lib/cresting';
import { money } from '@/lib/format';
import { crestPricesAction } from '../../actions';

export const metadata: Metadata = { title: 'Cresting prices' };

export default async function CrestPricesPage() {
  const staff = await requireStaff();
  const prices = crestPrices(staff.org.crestingPrices);
  return (
    <>
      <PageHeader
        staff={staff}
        title="Cresting prices."
        sub="Charged per item for each logo position, on top of the garment price, plus a one-off setup fee per job."
        actions={
          <Link href="/cresting" className="btn">
            ← Clothing Cresting
          </Link>
        }
      />
      <section className="panel">
        {hasRole(staff, 'manager') ? (
          <CrestPricesForm action={crestPricesAction} prices={prices} />
        ) : (
          <ul className="attention">
            {CREST_POSITIONS.map((p) => (
              <li key={p.key}>
                <span>{p.label}</span>
                <span className="muted">{CREST_METHODS.map((m) => `${m.label} ${money(prices.positions[p.key][m.key])}`).join(' · ')}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted" style={{ marginTop: 14 }}>
          Staff can still change the setup fee on each job, and edit any quote before it’s sent.
        </p>
      </section>
    </>
  );
}
