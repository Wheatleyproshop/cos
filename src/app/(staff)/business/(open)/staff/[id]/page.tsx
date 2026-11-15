import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PinForm, StaffRecordForm } from '@/components/staff-record-form';
import { PageHeader } from '@/components/views';
import { ctxFor } from '@/lib/action-utils';
import { requireBusiness } from '@/lib/business-lock';
import { money, todayInTz } from '@/lib/format';
import { listPayRuns, getPayRun, grossPence, netPence } from '@/lib/services/business/payroll';
import { getStaffRecord } from '@/lib/services/business/staff';
import { addDaysIso, timeEntriesBetween, workedMinutes } from '@/lib/services/business/time';
import { ServiceError } from '@/lib/services/common';
import { saveStaffAction, setPinAction } from '../../../actions';

export const metadata: Metadata = { title: 'Staff record · Business' };

const hours = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;

export default async function StaffRecordPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ reveal?: string }> }) {
  const staff = await requireBusiness();
  const { id } = await params;
  const { reveal } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const rec = await getStaffRecord(ctxFor(staff), id, { reveal: reveal === '1' }).catch((e) => {
    if (e instanceof ServiceError) notFound();
    throw e;
  });
  const tz = staff.org.timezone;
  const today = todayInTz(tz);
  const [entries, runs] = await Promise.all([timeEntriesBetween(staff.organisationId, addDaysIso(today, -27), addDaysIso(today, 1), tz, id), listPayRuns(staff.organisationId)]);
  const slips = (await Promise.all(runs.slice(0, 6).map((r) => getPayRun(staff.organisationId, r.id))))
    .flatMap((d) => (d ? d.slips.filter((s) => s.s.userId === id).map((s) => ({ run: d.run, s: s.s })) : []));
  const total = entries.reduce((n, e) => n + workedMinutes(e.e), 0);
  const revealing = reveal === '1';
  return (
    <>
      <PageHeader staff={staff} title={`${rec.user.name}.`} sub={`${rec.profile?.jobTitle || rec.user.role} · ${rec.user.email}`} actions={<Link href="/business/staff" className="btn">← All staff</Link>} />
      <div className="split">
        <section className="panel">
          <StaffRecordForm action={saveStaffAction.bind(null, id, revealing || !rec.profile?.hasSensitive)} profile={rec.profile} sensitive={rec.sensitive} revealHref={`/business/staff/${id}?reveal=1`} />
        </section>
        <div>
          <section className="panel">
            <h2>Clock-in PIN</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              {rec.profile?.hasPin ? 'Set — they can clock in on the shop screen.' : 'Not set yet. Give them a PIN so they can clock in on the shop screen.'}
            </p>
            <PinForm action={setPinAction.bind(null, id)} hasPin={Boolean(rec.profile?.hasPin)} />
          </section>
          <section className="panel" style={{ marginTop: 18 }}>
            <div className="panel-head">
              <h2>Last 4 weeks</h2>
              <b>{hours(total)}</b>
            </div>
            {entries.length ? (
              <ul className="attention">
                {entries.slice(-10).reverse().map(({ e }) => (
                  <li key={e.id}>
                    <span>{e.clockIn.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz })}</span>
                    <span className="muted">
                      {e.clockIn.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz })}–
                      {e.clockOut ? e.clockOut.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }) : 'still in'} · {hours(workedMinutes(e))}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No hours recorded.</p>
            )}
            <Link href="/business/time" className="muted">
              Hours & rota →
            </Link>
          </section>
          <section className="panel" style={{ marginTop: 18 }}>
            <h2>Payslips</h2>
            {slips.length ? (
              <ul className="attention">
                {slips.map(({ run, s }) => (
                  <li key={s.id}>
                    <Link href={`/business/payroll/${run.id}/slip/${s.id}`} className="rowtitle">
                      Paid {run.payDate}
                    </Link>
                    <span className="muted">
                      gross {money(grossPence(s))} · net {money(netPence(s))}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">None yet.</p>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
