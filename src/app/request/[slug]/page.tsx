import type { Metadata } from 'next';
import { and, eq, isNull } from 'drizzle-orm';
import { InvalidLink, PublicShell } from '@/components/public-shell';
import { OrderRequestForm } from '@/components/order-request-form';
import { withTenant } from '@/db';
import { brands, supplierAccounts } from '@/db/schema';
import { findRequestShop, NEEDED_BY } from '@/lib/services/order-requests';
import { submitOrderRequestAction } from './actions';

// Absolute title: customer pages never mention COS.
export const metadata: Metadata = { title: { absolute: 'Request a special order' } };

export default async function OrderRequestPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const org = await findRequestShop(slug);
  if (!org) return <InvalidLink title="This page isn’t available" body="Special orders can’t be requested online at the moment. Please contact the shop." />;
  // Brand suggestions: the shop's supplier accounts and fitting brands (customers can still type any brand).
  const brandNames = await withTenant(org.id, async (tx) => {
    const a = await tx.select({ name: supplierAccounts.brand }).from(supplierAccounts).where(and(eq(supplierAccounts.active, true), isNull(supplierAccounts.removedAt)));
    const b = await tx.select({ name: brands.name }).from(brands).where(and(eq(brands.active, true), isNull(brands.removedAt)));
    const seen = new Map<string, string>();
    for (const { name } of [...a, ...b]) if (name.trim()) seen.set(name.trim().toLowerCase(), name.trim());
    return [...seen.values()].sort((x, y) => x.localeCompare(y));
  }).catch(() => [] as string[]);
  return (
    <PublicShell org={org}>
      <div className="design-intro">
        <h1>Request a special order</h1>
        <p>
          Can’t find what you’re after? Tell us what you’d like and we’ll check price and availability with the manufacturer, then send you a quote
          to approve — usually within one working day. Nothing is ordered until you say yes.
        </p>
      </div>
      <OrderRequestForm action={submitOrderRequestAction.bind(null, org.slug)} brands={brandNames} neededBy={NEEDED_BY} />
    </PublicShell>
  );
}
