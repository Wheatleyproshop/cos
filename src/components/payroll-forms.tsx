'use client';

import { useState } from 'react';
import { ActionForm, Field, FormMessage, Submit, type BoundAction } from './forms';

export function NewPayRunForm({ action, defaults }: { action: BoundAction; defaults: { periodStart: string; periodEnd: string; payDate: string } }) {
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <div className="fields three">
            <Field state={s} name="periodStart" label="Pay period from" type="date" defaultValue={defaults.periodStart} />
            <Field state={s} name="periodEnd" label="To" type="date" defaultValue={defaults.periodEnd} />
            <Field state={s} name="payDate" label="Pay day" type="date" defaultValue={defaults.payDate} />
          </div>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 8 }}>
            <Submit pendingText="Working out pay…">Start pay run</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}

const p2 = (n: number) => (n / 100).toFixed(2);
type MoneyKey =
  | 'basicPence' | 'holidayPayPence' | 'bonusPence' | 'taxPence' | 'employeeNiPence' | 'pensionPence' | 'otherDeductionsPence' | 'employerNiPence' | 'employerPensionPence';

/** One person's payslip figures; gross and net update as you type. */
export function PayslipRow({
  action, values, locked, hasFile,
}: { action: BoundAction; values: Record<MoneyKey, number> & { notes: string }; locked: boolean; hasFile: boolean }) {
  const [v, setV] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(values)) if (typeof x === 'number') out[k] = p2(x);
    return out;
  });
  const n = (k: MoneyKey) => Number(v[k] || 0) || 0;
  const gross = n('basicPence') + n('holidayPayPence') + n('bonusPence');
  const net = gross - n('taxPence') - n('employeeNiPence') - n('pensionPence') - n('otherDeductionsPence');
  const input = (k: MoneyKey, label: string) => (
    <label className="field">
      <span>{label}</span>
      <input name={k} inputMode="decimal" value={v[k] ?? ''} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
    </label>
  );
  return (
    <ActionForm action={action} encType="multipart/form-data">
      {(s) => (
        <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="slip-grid">
            <div>
              <small className="slip-h">Pay</small>
              {input('basicPence', 'Basic £')}
              {input('holidayPayPence', 'Holiday pay £')}
              {input('bonusPence', 'Bonus / overtime £')}
            </div>
            <div>
              <small className="slip-h">Deductions</small>
              {input('taxPence', 'Income tax £')}
              {input('employeeNiPence', 'Employee NI £')}
              {input('pensionPence', 'Pension £')}
              {input('otherDeductionsPence', 'Other £')}
            </div>
            <div>
              <small className="slip-h">Employer costs (on top of pay)</small>
              {input('employerNiPence', 'Employer NI £')}
              {input('employerPensionPence', 'Employer pension £')}
              <div className="slip-net">
                <span>Gross £{gross.toFixed(2)}</span>
                <b>Net pay £{net.toFixed(2)}</b>
              </div>
            </div>
          </div>
          {!locked ? (
            <div className="slip-foot">
              <Field state={s} name="notes" label="Note on payslip" defaultValue={values.notes} />
              <label className="field">
                <span>{hasFile ? 'Replace payslip PDF' : 'Attach payslip PDF (optional)'}</span>
                <input type="file" name="file" accept="application/pdf" />
              </label>
              <div className="actions" style={{ margin: 0 }}>
                <Submit className="btn">Save</Submit>
              </div>
            </div>
          ) : null}
          <FormMessage state={s} />
        </fieldset>
      )}
    </ActionForm>
  );
}
