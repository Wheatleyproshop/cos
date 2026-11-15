import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PrintButton } from '@/components/print-button';
import { requireBusiness } from '@/lib/business-lock';
import { money } from '@/lib/format';
import { getPayRun, grossPence, netPence } from '@/lib/services/business/payroll';

export const metadata: Metadata = { title: 'Payslip' };

/** A printable payslip (Print → Save as PDF to email it). */
export default async function PayslipPage({ params }: { params: Promise<{ id: string; slipId: string }> }) {
  const staff = await requireBusiness();
  const { id, slipId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(slipId)) notFound();
  const data = await getPayRun(staff.organisationId, id);
  const row = data?.slips.find((x) => x.s.id === slipId);
  if (!data || !row) notFound();
  const { run } = data;
  const s = row.s;
  const line = (label: string, p: number) =>
    p ? (
      <tr>
        <td>{label}</td>
        <td className="num">{money(p)}</td>
      </tr>
    ) : null;
  return (
    <div className="payslip-page">
      <div className="payslip-actions">
        <PrintButton />
      </div>
      <article className="payslip">
        <header>
          <div>
            <h1>Payslip</h1>
            <p>{staff.org.storeName}</p>
          </div>
          <div className="payslip-meta">
            <div>
              <small>Employee</small>
              <b>{row.name}</b>
            </div>
            <div>
              <small>Pay period</small>
              <b>
                {run.periodStart} to {run.periodEnd}
              </b>
            </div>
            <div>
              <small>Pay date</small>
              <b>{run.payDate}</b>
            </div>
          </div>
        </header>
        <div className="payslip-cols">
          <table>
            <thead>
              <tr>
                <th>Payments</th>
                <th className="num">£</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{row.payType === 'salary' ? 'Salary' : `Basic pay (${(s.minutesWorked / 60).toFixed(2)} hours × ${money(s.hourlyRatePence)})`}</td>
                <td className="num">{money(s.basicPence)}</td>
              </tr>
              {line('Holiday pay', s.holidayPayPence)}
              {line('Bonus / overtime', s.bonusPence)}
              <tr className="sum">
                <td>Gross pay</td>
                <td className="num">{money(grossPence(s))}</td>
              </tr>
            </tbody>
          </table>
          <table>
            <thead>
              <tr>
                <th>Deductions</th>
                <th className="num">£</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Income tax</td>
                <td className="num">{money(s.taxPence)}</td>
              </tr>
              <tr>
                <td>National Insurance</td>
                <td className="num">{money(s.employeeNiPence)}</td>
              </tr>
              {line('Pension', s.pensionPence)}
              {line('Other', s.otherDeductionsPence)}
              <tr className="sum">
                <td>Total deductions</td>
                <td className="num">{money(grossPence(s) - netPence(s))}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="payslip-net">
          <span>Net pay</span>
          <b>{money(netPence(s))}</b>
        </div>
        {s.notes ? <p className="payslip-note">{s.notes}</p> : null}
        {s.employerNiPence || s.employerPensionPence ? (
          <p className="payslip-small">
            Paid by your employer on top of your pay: {s.employerNiPence ? `National Insurance ${money(s.employerNiPence)}` : ''}
            {s.employerNiPence && s.employerPensionPence ? ' · ' : ''}
            {s.employerPensionPence ? `pension ${money(s.employerPensionPence)}` : ''}.
          </p>
        ) : null}
      </article>
    </div>
  );
}
