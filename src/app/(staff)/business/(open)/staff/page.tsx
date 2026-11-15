import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/views';
import { requireBusiness } from '@/lib/business-lock';
import { money } from '@/lib/format';
import { shortDate } from '@/lib/short-date';
import { listStaff } from '@/lib/services/business/staff';

export const metadata: Metadata = { title: 'Staff · Business' };

export default async function StaffPage() {
  const staff = await requireBusiness();
  const team = await listStaff(staff.organisationId);
  const current = team.filter((t) => !t.profile?.endDate);
  const left = team.filter((t) => t.profile?.endDate);
  const row = (t: (typeof team)[number]) => {
    const p = t.profile;
    return (
      <tr key={t.id}>
        <td>
          <Link href={`/business/staff/${t.id}`} className="rowtitle">
            {t.name}
          </Link>
          <div className="muted">{p?.jobTitle || t.role}</div>
        </td>
        <td>{p ? (p.payType === 'salary' ? `${money(p.annualSalaryPence)} a year` : p.hourlyRatePence ? `${money(p.hourlyRatePence)} an hour` : <span className="flag">no rate</span>) : <span className="flag">not set up</span>}</td>
        <td>{p?.contractedMinutesPerWeek ? `${p.contractedMinutesPerWeek / 60} h/week` : <span className="muted">flexible</span>}</td>
        <td>{p?.startDate ? shortDate(p.startDate) : '—'}</td>
        <td>{p?.hasPin ? '✓ PIN set' : <span className="muted">no PIN</span>}</td>
        <td>{p?.hasSensitive ? '🔒 on file' : <span className="muted">—</span>}</td>
      </tr>
    );
  };
  return (
    <>
      <PageHeader staff={staff} title="Staff." sub="Pay rates, contracts, contact and private details, and clock-in PINs." actions={<span />} />
      <section className="panel tablewrap">
        <table className="compact">
          <thead>
            <tr>
              <th>Name</th>
              <th>Pay</th>
              <th>Contract</th>
              <th>Started</th>
              <th>Clock in</th>
              <th>Private details</th>
            </tr>
          </thead>
          <tbody>{current.map(row)}</tbody>
        </table>
        <p className="muted" style={{ marginBottom: 0 }}>
          To add someone, add them as a team member in <Link href="/settings">Store settings → Team</Link> (they don’t need to be able to sign in), then set
          up their record here.
        </p>
      </section>
      {left.length ? (
        <section className="panel tablewrap" style={{ marginTop: 18 }}>
          <h2>Former staff</h2>
          <table className="compact">
            <tbody>{left.map(row)}</tbody>
          </table>
        </section>
      ) : null}
    </>
  );
}
