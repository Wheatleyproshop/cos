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
        sub="Short and long pile mats with the engraving included, the carry case deal, engraving-only prices for a customer’s own mat, and an optional setup fee per job."
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
                <span>{m.name}, engraved</span>
                <span className="muted">{money(m.pricePence)} each</span>
              </li>
            ))}
            {prices.caseDealPence ? (
              <li>
                <span>Carry case deal (mat + case + engraving)</span>
                <span className="muted">{money(prices.caseDealPence)}</span>
              </li>
            ) : null}
            {MAT_POSITIONS.map((p) => (
              <li key={p.key}>
                <span>Own mat: {p.label.toLowerCase()} engraving</span>
                <span className="muted">{money(prices.positions[p.key])} each</span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted" style={{ marginTop: 14 }}>
          Engraving is included in the mat prices, on the lip, underneath or both. The per-position prices are only for engraving a customer’s own mat. Staff can change the price and setup fee on each job.
        </p>
      </section>
    </>
  );
}
