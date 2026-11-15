import type { Metadata } from 'next';
import Link from 'next/link';
import { NewPayRunForm } from '@/components/payroll-forms';
import { PageHeader } from '@/components/views';
import { requireBusiness } from '@/lib/business-lock';
import { money, todayInTz } from '@/lib/format';
import { listPayRuns } from '@/lib/services/business/payroll';
import { createPayRunAction } from '../../actions';

export const metadata: Metadata = { title: 'Payroll · Business' };

const nextDay = (iso: string) => new Date(new Date(`${iso}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);

export default async function PayrollPage() {
  const staff = await requireBusiness();
  const runs = await listPayRuns(staff.organisationId);
  // Suggest the day after the last run up to today, or else last calendar month.
  const today = todayInTz(staff.org.timezone);
  const [y, m] = today.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
  const lastEnd = runs[0]?.periodEnd;
  const defaults = lastEnd && lastEnd >= start ? { periodStart: nextDay(lastEnd), periodEnd: today, payDate: today } : { periodStart: start, periodEnd: end, payDate: today };
  return (
    <>
      <PageHeader staff={staff} title="Payroll." sub="Pay worked out from hours and rates; payslips, records and an export." actions={<span />} />
      <div className="notice">
        <b>How this works:</b> COS works out basic pay from clocked hours × each person’s rate (or their salary for the period). Enter tax, NI and pension
        from{' '}
        <a href="https://www.gov.uk/basic-paye-tools" target="_blank" rel="noreferrer">
          HMRC Basic PAYE Tools
        </a>{' '}
        (free) — that’s also how employers must report pay to HMRC on or before each pay day. COS then gives you net pay, payslips and a record of every run.
      </div>
      <section className="panel" style={{ marginTop: 18 }}>
        <h2>New pay run</h2>
        <NewPayRunForm action={createPayRunAction} defaults={defaults} />
      </section>
      <section className="panel tablewrap" style={{ marginTop: 18 }}>
        <h2>Pay runs</h2>
        {runs.length ? (
          <table className="compact">
            <thead>
              <tr>
                <th>Period</th>
                <th>Paid</th>
                <th className="num">People</th>
                <th className="num">Gross</th>
                <th className="num">Net</th>
                <th className="num">Cost to business</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/business/payroll/${r.id}`} className="rowtitle">
                      {r.periodStart} → {r.periodEnd}
                    </Link>
                  </td>
                  <td>{r.payDate}</td>
                  <td className="num">{r.people}</td>
                  <td className="num">{money(r.gross)}</td>
                  <td className="num">{money(r.net)}</td>
                  <td className="num">{money(r.employerCost)}</td>
                  <td>
                    <span className={`badge ${r.status === 'finalised' ? 'ready' : ''}`}>{r.status === 'finalised' ? 'Finalised' : 'Draft'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No pay runs yet.</p>
        )}
      </section>
    </>
  );
}
