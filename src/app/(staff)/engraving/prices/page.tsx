import type { Metadata } from 'next';
import Link from 'next/link';
import { MatPricesForm } from '@/components/mat-prices-form';
import { PageHeader } from '@/components/views';
import { hasRole, requireStaff } from '@/lib/auth';
import { money } from '@/lib/format';
import { MAT_POSITIONS, matPrices } from '@/lib/mat-engraving';
import { matPricesAction } from '../../actions';

export const metadata: Metadata = { title: 'Engraving prices' };

export default async function MatPricesPage() {
  const staff = await requireStaff();
  const prices = matPrices(staff.org.matEngraving);
  return (
    <>
      <PageHeader
        staff={staff}
        title="Engraving prices."
        sub="Short and long pile mats, a price per engraving position (each mat), and an optional setup fee per job."
        actions={
          <Link href="/engraving" className="btn">
            ← Mat Engraving
          </Link>
        }
      />
      <section className="panel">
        {hasRole(staff, 'manager') ? (
          <MatPricesForm action={matPricesAction} prices={prices} />
        ) : (
          <ul className="attention">
            {prices.mats.map((m) => (
              <li key={m.key}>
                <span>{m.name}</span>
                <span className="muted">{money(m.pricePence)} each</span>
              </li>
            ))}
            {MAT_POSITIONS.map((p) => (
              <li key={p.key}>
                <span>{p.label} engraving</span>
                <span className="muted">{money(prices.positions[p.key])} each</span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted" style={{ marginTop: 14 }}>
          Staff can change the mat price and setup fee on each job. “Customer’s own mat” is engraving only.
        </p>
      </section>
    </>
  );
}
