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
        sub="The mat, plus a price per engraving position (each mat), plus an optional setup fee per job."
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
            <li>
              <span>{prices.matName}</span>
              <span className="muted">{money(prices.matPricePence)} each</span>
            </li>
            {MAT_POSITIONS.map((p) => (
              <li key={p.key}>
                <span>{p.label} engraving</span>
                <span className="muted">{money(prices.positions[p.key])} each</span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted" style={{ marginTop: 14 }}>
          Staff can change the mat price and setup fee on each job (for example £0 if the customer brings their own mat).
        </p>
      </section>
    </>
  );
}
