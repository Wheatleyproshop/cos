import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CustomerForm } from '@/components/misc-forms';
import { Badge, DetailBox, PageHeader } from '@/components/views';
import { requireStaff } from '@/lib/auth';
import { money, niceDate, stamp } from '@/lib/format';
import { getCustomerDetail } from '@/lib/queries';
import { QUOTE_STATUS_LABELS, statusLabel } from '@/lib/status';
import type { Order } from '@/db/schema';
import { updateCustomerAction } from '../../actions';

export const metadata: Metadata = { title: 'Customer' };

function OrderList({ orders, tz }: { orders: Order[]; tz: string }) {
  if (!orders.length) return <p className="muted">None.</p>;
  return (
    <ul className="attention">
      {orders.map((o) => (
        <li key={o.id}>
          <span>
            <Link href={`/orders/${o.orderNumber}`} className="rowtitle" scroll={false}>
              {o.brand} {o.product}
            </Link>
            <div className="muted">
              {o.orderNumber} · {stamp(o.createdAt, tz)} · ETA {niceDate(o.etaDate)}
            </div>
          </span>
          <span style={{ textAlign: 'right' }}>
            <Badge status={o.status} text={o.archivedAt ? 'Archived' : statusLabel(o.status)} />
            <div className="muted">{money(o.totalGrossPence)}</div>
          </span>
        </li>
      ))}
    </ul>
  );
}

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaff();
  const { id } = await params;
  const d = await getCustomerDetail(staff.org, id);
  if (!d) notFound();
  const { customer: c } = d;
  const tz = staff.org.timezone;
  return (
    <>
      <PageHeader
        staff={staff}
        title={c.name}
        sub={`Customer since ${stamp(c.createdAt, tz).split(' · ')[0]}`}
        actions={
          <>
            <Link href={`/orders/new?customer=${c.id}&mode=quote`} className="btn" scroll={false}>
              New quote
            </Link>
            <Link href={`/orders/new?customer=${c.id}`} className="btn primary" scroll={false}>
              ＋ &nbsp; New order
            </Link>
          </>
        }
      />
      <div className="detailgrid three" style={{ marginBottom: 18 }}>
        <DetailBox label="Contact" sub={c.phone || 'No phone'}>
          <a href={`mailto:${c.email}`}>{c.email}</a>
        </DetailBox>
        <DetailBox label="Lifetime order value" sub={`${d.activeOrders.length} active · ${d.pastOrders.length} past`}>
          {money(d.lifetimePence)}
        </DetailBox>
        <DetailBox label="Total paid">{money(d.paidPence)}</DetailBox>
      </div>
      <div className="split">
        <div>
          <section className="panel">
            <h2>Active orders</h2>
            <OrderList orders={d.activeOrders} tz={tz} />
          </section>
          <section className="panel">
            <h2>Quotes</h2>
            {d.quotes.length ? (
              <ul className="attention">
                {d.quotes.map((q) => (
                  <li key={q.id}>
                    <span>
                      <Link href={`/quotes/${q.quoteNumber}`} className="rowtitle" scroll={false}>
                        {q.brand} {q.product}
                      </Link>
                      <div className="muted">
                        {q.quoteNumber} · {stamp(q.createdAt, tz)}
                      </div>
                    </span>
                    <span style={{ textAlign: 'right' }}>
                      <Badge status="quote" text={QUOTE_STATUS_LABELS[q.status]} />
                      <div className="muted">{money(q.totalGrossPence)}</div>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">None.</p>
            )}
          </section>
          <section className="panel">
            <h2>Order history</h2>
            <OrderList orders={d.pastOrders} tz={tz} />
          </section>
        </div>
        <div>
          <section className="panel">
            <h2>Saved builds</h2>
            <p style={{ marginTop: 0 }}>Specifications this customer has ordered. Reorder one to start a new order with it pre-filled.</p>
            {d.builds.length ? (
              <ul className="attention">
                {d.builds.map((b) => (
                  <li key={b.orderNumber}>
                    <span>
                      <b>
                        {b.brand} {b.product}
                      </b>
                      <div className="muted" style={{ whiteSpace: 'pre-line' }}>
                        {b.spec}
                      </div>
                    </span>
                    <Link className="btn small" href={`/orders/new?customer=${c.id}&from=${b.orderNumber}`} scroll={false}>
                      Reorder
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No builds yet.</p>
            )}
          </section>
          <section className="panel">
            <h2>Contact details</h2>
            <CustomerForm action={updateCustomerAction.bind(null, c.id)} values={{ name: c.name, email: c.email, phone: c.phone, notes: c.notes }} />
          </section>
        </div>
      </div>
    </>
  );
}
