'use client';

import Link from 'next/link';
import type { StaffSensitive } from '@/db/schema';
import { ActionForm, Field, FormMessage, Submit, type BoundAction } from './forms';

const pounds = (p: number | null | undefined) => (p ? (p / 100).toFixed(2) : '');

type Profile = {
  jobTitle: string; phone: string; personalEmail: string; startDate: string | null; endDate: string | null; payType: 'hourly' | 'salary';
  hourlyRatePence: number; annualSalaryPence: number; contractedMinutesPerWeek: number; holidayTenthsPerYear: number;
  emergencyName: string; emergencyPhone: string; emergencyRelation: string; notes: string; hasSensitive: boolean;
} | null;

export function StaffRecordForm({ action, profile, sensitive, revealHref }: { action: BoundAction; profile: Profile; sensitive: StaffSensitive | null; revealHref: string }) {
  const p = profile;
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <h3>Job & pay</h3>
          <div className="fields three">
            <Field state={s} name="jobTitle" label="Job title" defaultValue={p?.jobTitle} placeholder="e.g. Shop assistant" />
            <Field state={s} name="startDate" label="Start date" type="date" defaultValue={p?.startDate} />
            <Field state={s} name="endDate" label="Leaving date" type="date" defaultValue={p?.endDate} hint="Only when they’ve left" />
            <Field state={s} name="payType" label="Paid" options={[{ value: 'hourly', label: 'By the hour' }, { value: 'salary', label: 'Salary' }]} defaultValue={p?.payType ?? 'hourly'} />
            <Field state={s} name="hourlyRatePence" label="Hourly rate (£)" inputMode="decimal" defaultValue={pounds(p?.hourlyRatePence)} placeholder="12.21" />
            <Field state={s} name="annualSalaryPence" label="Annual salary (£)" inputMode="decimal" defaultValue={pounds(p?.annualSalaryPence)} />
            <Field state={s} name="contractedMinutesPerWeek" label="Contracted hours a week" inputMode="decimal" defaultValue={p ? String(p.contractedMinutesPerWeek / 60) : ''} hint="0 for flexible / zero hours" />
            <Field state={s} name="holidayTenthsPerYear" label="Holiday days a year" inputMode="decimal" defaultValue={p ? String(p.holidayTenthsPerYear / 10) : '28'} hint="Full time: 28 days including bank holidays" />
          </div>
          <h3>Contact</h3>
          <div className="fields three">
            <Field state={s} name="phone" label="Mobile" type="tel" defaultValue={p?.phone} />
            <Field state={s} name="personalEmail" label="Personal email" type="email" defaultValue={p?.personalEmail} />
            <span />
            <Field state={s} name="emergencyName" label="Emergency contact" defaultValue={p?.emergencyName} />
            <Field state={s} name="emergencyPhone" label="Their phone" type="tel" defaultValue={p?.emergencyPhone} />
            <Field state={s} name="emergencyRelation" label="Relationship" defaultValue={p?.emergencyRelation} />
          </div>
          <h3>
            Private details <span className="muted">🔒 encrypted</span>
          </h3>
          {sensitive || !p?.hasSensitive ? (
            <div className="fields three">
              <Field state={s} name="niNumber" label="National Insurance number" defaultValue={sensitive?.niNumber} placeholder="QQ 12 34 56 C" />
              <Field state={s} name="dateOfBirth" label="Date of birth" type="date" defaultValue={sensitive?.dateOfBirth} />
              <Field state={s} name="taxCode" label="Tax code" defaultValue={sensitive?.taxCode} placeholder="1257L" />
              <Field state={s} name="address" label="Home address" wide defaultValue={sensitive?.address} />
              <Field state={s} name="postcode" label="Postcode" defaultValue={sensitive?.postcode} />
              <Field state={s} name="bankName" label="Bank" defaultValue={sensitive?.bankName} />
              <Field state={s} name="accountName" label="Name on account" defaultValue={sensitive?.accountName} />
              <Field state={s} name="sortCode" label="Sort code" defaultValue={sensitive?.sortCode} placeholder="12-34-56" />
              <Field state={s} name="accountNumber" label="Account number" defaultValue={sensitive?.accountNumber} />
            </div>
          ) : (
            <p className="muted">
              Stored and hidden. <Link href={revealHref}>Show and edit private details</Link> (recorded in the history).
            </p>
          )}
          <h3>Notes</h3>
          <Field state={s} name="notes" label="Notes (owner only)" textarea defaultValue={p?.notes} />
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 10 }}>
            <Submit>Save record</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function PinForm({ action, hasPin }: { action: BoundAction; hasPin: boolean }) {
  return (
    <ActionForm action={action} resetOnSuccess>
      {(s) => (
        <>
          <div className="fields" style={{ alignItems: 'end' }}>
            <Field state={s} name="pin" label={hasPin ? 'New clock-in PIN' : 'Clock-in PIN'} type="password" inputMode="decimal" autoComplete="new-password" hint="4 to 6 digits. Leave empty and save to remove it." />
            <div className="actions" style={{ margin: 0 }}>
              <Submit className="btn">{hasPin ? 'Change PIN' : 'Set PIN'}</Submit>
            </div>
          </div>
          <FormMessage state={s} />
        </>
      )}
    </ActionForm>
  );
}
