import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionButton } from '@/components/forms';
import { PayslipRow } from '@/components/payroll-forms';
import { PageHeader } from '@/components/views';
import { requireBusiness } from '@/lib/business-lock';
import { money } from '@/lib/format';
import { getPayRun, grossPence, netPence } from '@/lib/services/business/payroll';
import { finalisePayRunAction, updatePayslipAction } from '../../../actions';

export const metadata: Metadata = { title: 'Pay run · Business' };

export default async function PayRunPage({ params }: { params: Promise<{ id: string }> }) {
  const staff = await requireBusiness();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const data = await getPayRun(staff.organisationId, id);
  if (!data) notFound();
  const { run, slips } = data;
  const locked = run.status === 'finalised';
  const tot = (f: (s: (typeof slips)[number]['s']) => number) => slips.reduce((n, x) => n + f(x.s), 0);
  return (
    <>
      <PageHeader
        staff={staff}
        title={`Pay run: ${run.periodStart} → ${run.periodEnd}.`}
        sub={`Pay day ${run.payDate} · ${locked ? 'Finalised — locked' : 'Draft — enter deductions, then finalise'}`}
        actions={
          <>
            <a className="btn" href={`/api/business/payrun/${run.id}`} download>
              ⤓ Export CSV
            </a>
            <Link href="/business/payroll" className="btn">
              ← Payroll
            </Link>
          </>
        }
      />
      <div className="grid biz-kpis">
        <div className="metric">
          <small>Gross pay</small>
          <strong className="metric-money">{money(tot(grossPence))}</strong>
        </div>
        <div className="metric">
          <small>Net pay to staff</small>
          <strong className="metric-money">{money(tot(netPence))}</strong>
        </div>
        <div className="metric">
          <small>Owed to HMRC</small>
          <strong className="metric-money">{money(tot((s) => s.taxPence + s.employeeNiPence + s.employerNiPence))}</strong>
          <em>tax + employee & employer NI</em>
        </div>
        <div className="metric">
          <small>Cost to business</small>
          <strong className="metric-money">{money(tot((s) => grossPence(s) + s.employerNiPence + s.employerPensionPence))}</strong>
        </div>
      </div>
      {slips.map(({ s, name, jobTitle, payType }) => (
        <section key={s.id} className="panel slip">
          <div className="panel-head">
            <h2>
              {name} <span className="muted">{jobTitle}</span>
            </h2>
            <span className="muted">
              {payType === 'salary' ? 'Salary' : `${(s.minutesWorked / 60).toFixed(2)} h × ${money(s.hourlyRatePence)}`} ·{' '}
              <Link href={`/business/payroll/${run.id}/slip/${s.id}`}>View payslip</Link>
              {s.fileKey ? (
                <>
                  {' · '}
                  <a href={`/api/business/payslip/${s.id}`} target="_blank" rel="noreferrer">
                    PDF ↗
                  </a>
                </>
              ) : null}
            </span>
          </div>
          <PayslipRow
            action={updatePayslipAction.bind(null, s.id)}
            locked={locked}
            hasFile={Boolean(s.fileKey)}
            values={{
              basicPence: s.basicPence, holidayPayPence: s.holidayPayPence, bonusPence: s.bonusPence, taxPence: s.taxPence, employeeNiPence: s.employeeNiPence,
              pensionPence: s.pensionPence, otherDeductionsPence: s.otherDeductionsPence, employerNiPence: s.employerNiPence, employerPensionPence: s.employerPensionPence, notes: s.notes,
            }}
          />
        </section>
      ))}
      {!locked ? (
        <section className="panel">
          <p className="muted" style={{ marginTop: 0 }}>
            When everything matches what you’ve submitted to HMRC, finalise the run. It’s then locked so the record can’t change.
          </p>
          <ActionButton action={finalisePayRunAction.bind(null, run.id)} className="btn primary" confirm="Finalise and lock this pay run? Figures can’t be changed afterwards.">
            Finalise pay run
          </ActionButton>
        </section>
      ) : null}
    </>
  );
}
