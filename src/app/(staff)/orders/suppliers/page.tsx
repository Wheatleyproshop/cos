import type { Metadata } from 'next';
import Link from 'next/link';
import { MarkPlacedForm, SheetButtons } from '@/components/supplier-sheet';
import { ChaseDaysForm } from '@/components/misc-forms';
import { PageHeader } from '@/components/views';
import { hasRole, requireStaff } from '@/lib/auth';
import { shortDate } from '@/lib/short-date';
import { chaseEmail, orderEmail, supplierSheets, type LeadTime, type SheetLine, type SupplierGroup } from '@/lib/services/supplier-sheets';
import { markSupplierPlacedAction, supplierChaseDaysAction } from '../../actions';

export const metadata: Metadata = { title: 'Supplier orders' };

function Lines({ lines, chase }: { lines: SheetLine[]; chase?: boolean }) {
  return (
    <div className="tablewrap">
      <table className="compact sheet-lines">
        <thead>
          <tr>
            <th>Our ref</th>
            <th>Item</th>
            <th className="num">Qty</th>
            <th>{chase ? 'Supplier ref' : 'Customer'}</th>
            <th>{chase ? 'Expected' : 'Taken'}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={`${l.orderId}-${l.itemIndex ?? 'o'}`}>
              <td>
                <Link href={`/orders/${l.orderNumber}`} className="rowtitle">
                  {l.orderNumber}
                </Link>
                {l.itemIndex !== null ? <div className="muted">item {l.itemIndex + 1}</div> : null}
              </td>
              <td>
                <b>{l.product}</b>
                {l.details.length ? <div className="muted sheet-details">{l.details.join(' · ')}</div> : null}
                {l.sku ? <div className="muted">Code {l.sku}</div> : null}
              </td>
              <td className="num">{l.quantity}</td>
              <td>{chase ? l.supplierReference || <span className="flag">none</span> : l.customer}</td>
              <td>
                {chase ? (
                  l.etaDate ? (
                    <span className={l.overdue ? 'flag' : ''}>{l.overdue ? `was due ${shortDate(l.etaDate)}` : shortDate(l.etaDate)}</span>
                  ) : (
                    <span className="muted">no date{l.placedAt ? ` · ordered ${shortDate(l.placedAt.toISOString().slice(0, 10))}` : ''}</span>
                  )
                ) : (
                  shortDate(l.takenAt.toISOString().slice(0, 10))
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const days = (n: number) => (n < 1 ? 'under a day' : `${Math.round(n)} day${Math.round(n) === 1 ? '' : 's'}`);

function LeadTable({ rows }: { rows: LeadTime[] }) {
  if (!rows.length) {
    return (
      <section className="panel">
        <p className="muted">
          Lead times appear once orders have been placed with a supplier and then marked as arrived. Each one is measured from the day it was placed to the
          day it came in.
        </p>
      </section>
    );
  }
  const max = Math.max(...rows.map((r) => r.slowestDays), 1);
  return (
    <section className="panel">
      <div className="tablewrap">
        <table className="compact turnaround">
          <thead>
            <tr>
              <th>Supplier</th>
              <th className="num">Usually</th>
              <th>Fastest – slowest</th>
              <th className="num">Average</th>
              <th className="num" title="Typical time for their five most recent deliveries">Lately</th>
              <th className="num">Measured</th>
              <th className="num">On order now</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const trend = r.recentMedianDays === null ? null : r.recentMedianDays - r.medianDays;
              return (
                <tr key={r.key}>
                  <td>
                    <b>{r.supplier}</b>
                  </td>
                  <td className="num">
                    <b>{days(r.medianDays)}</b>
                  </td>
                  <td>
                    <div className="range" aria-label={`${r.fastestDays} to ${r.slowestDays} days`}>
                      <span className="range-bar" style={{ left: `${(r.fastestDays / max) * 100}%`, width: `${Math.max(2, ((r.slowestDays - r.fastestDays) / max) * 100)}%` }} />
                      <span className="range-avg" style={{ left: `${(r.medianDays / max) * 100}%` }} />
                    </div>
                    <small className="muted">
                      {Math.round(r.fastestDays)}–{Math.round(r.slowestDays)} days
                    </small>
                  </td>
                  <td className="num">{days(r.avgDays)}</td>
                  <td className="num">
                    {r.recentMedianDays === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <span className={trend! >= 2 ? 'flag' : ''} title={trend! >= 2 ? 'Slower than usual lately' : trend! <= -2 ? 'Quicker than usual lately' : 'About the same as usual'}>
                        {days(r.recentMedianDays)} {trend! >= 2 ? '▲' : trend! <= -2 ? '▼' : ''}
                      </span>
                    )}
                  </td>
                  <td className="num">{r.measured}</td>
                  <td className="num">{r.onOrderNow || <span className="muted">0</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ marginBottom: 0 }}>
        From the day each order (or item) was placed with the supplier to the day it arrived in store, over the last 12 months. “Usually” is the typical
        (middle) time, so one very slow delivery doesn’t skew it. ▲ means a supplier has been slower than usual on its last five deliveries.
      </p>
    </section>
  );
}

function SupplierHead({ g }: { g: SupplierGroup }) {
  const a = g.account;
  return (
    <div className="sheet-head">
      <div>
        <h2>
          {g.supplier}
          {g.lead && g.lead.measured >= 2 ? (
            <span className="sheet-lead" title={`Measured over ${g.lead.measured} deliveries in the last 12 months`}>
              usually {days(g.lead.medianDays)} to arrive
            </span>
          ) : null}
        </h2>
        {a ? (
          <div className="muted sheet-acct">
            {[a.accountNumber && `Account ${a.accountNumber}`, a.ordersEmail || a.repEmail, a.repName && `Rep: ${a.repName}${a.repPhone ? ` ${a.repPhone}` : ''}`, !a.repPhone && a.headOfficePhone]
              .filter(Boolean)
              .join(' · ')}
            {a.portalUrl ? (
              <>
                {' · '}
                <a href={a.portalUrl} target="_blank" rel="noreferrer">
                  Order portal ↗
                </a>
              </>
            ) : null}
          </div>
        ) : (
          <div className="muted sheet-acct">
            No account details yet — <Link href="/accounts">add {g.supplier} on the Accounts page</Link> to fill in the email and account number.
          </div>
        )}
      </div>
    </div>
  );
}

export default async function SupplierOrdersPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const data = await supplierSheets(staff.org);
  const tab = sp.tab === 'chase' ? 'chase' : sp.tab === 'lead' ? 'lead' : 'order';
  const groups = tab === 'chase' ? data.toChase : data.toOrder;
  const count = (gs: SupplierGroup[]) => gs.reduce((n, g) => n + g.lines.length, 0);
  return (
    <>
      <PageHeader staff={staff} title="Supplier orders." sub="Everything waiting to be ordered, one sheet per supplier — and what to chase." />
      <div className="seg viewtabs" role="tablist" aria-label="Supplier orders">
        <Link href="/orders/suppliers" className={tab === 'order' ? 'on' : ''} role="tab" aria-selected={tab === 'order'} scroll={false}>
          To order ({count(data.toOrder)})
        </Link>
        <Link href="/orders/suppliers?tab=chase" className={tab === 'chase' ? 'on' : ''} role="tab" aria-selected={tab === 'chase'} scroll={false}>
          To chase ({count(data.toChase)})
        </Link>
        <Link href="/orders/suppliers?tab=lead" className={tab === 'lead' ? 'on' : ''} role="tab" aria-selected={tab === 'lead'} scroll={false}>
          Lead times
        </Link>
      </div>

      {tab === 'lead' ? (
        <>
          <p className="muted sheet-intro">How long each supplier takes to deliver, from placing the order to it arriving in store.</p>
          <LeadTable rows={data.leadTimes} />
        </>
      ) : tab === 'chase' ? (
        <p className="muted sheet-intro">
          Placed orders past their expected date, or with no expected date that are taking noticeably longer than that supplier usually does (or over{' '}
          {data.chaseDays} days, for suppliers without enough history yet).
        </p>
      ) : (
        <p className="muted sheet-intro">
          Orders on the order pad under To place, grouped by brand. Email or print each sheet, then mark it as placed — customers aren’t emailed about this step.
        </p>
      )}

      {tab !== 'lead' && !groups.length ? (
        <section className="panel">
          <p className="muted">{tab === 'chase' ? 'Nothing to chase — every placed order is on time.' : 'Nothing waiting to be ordered.'}</p>
        </section>
      ) : null}

      {(tab === 'lead' ? [] : groups).map((g) => {
        const mail = tab === 'chase' ? chaseEmail(staff.org, g, staff.name) : orderEmail(staff.org, g, staff.name);
        const id = `sheet-${tab}-${g.key.replace(/[^a-z0-9]+/g, '-')}`;
        return (
          <section key={g.key} id={id} className="panel sheet">
            <div className="sheet-top">
              <SupplierHead g={g} />
              <SheetButtons id={id} to={mail.to} subject={mail.subject} body={mail.body} />
            </div>
            <div className="sheet-print-title">
              {mail.subject}
            </div>
            <Lines lines={g.lines} chase={tab === 'chase'} />
            {tab === 'order' ? <MarkPlacedForm action={markSupplierPlacedAction.bind(null, g.key)} count={g.lines.length} /> : null}
          </section>
        );
      })}

      {tab === 'chase' ? (
        <section className="panel" style={{ marginTop: 18 }}>
          <ChaseDaysForm action={supplierChaseDaysAction} days={data.chaseDays} disabled={!hasRole(staff, 'manager')} />
        </section>
      ) : null}
    </>
  );
}
