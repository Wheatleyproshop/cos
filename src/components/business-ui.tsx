'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import type { FormState } from '@/lib/action-utils';
import { ActionForm, Field, FormMessage, Submit, type BoundAction } from './forms';

export function UnlockForm({ action, next }: { action: BoundAction; next: string }) {
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <input type="hidden" name="next" value={next} />
          <Field state={s} name="password" label="Your password" type="password" required autoComplete="current-password" />
          <FormMessage state={s} />
          <div className="actions">
            <Submit pendingText="Checking…">Unlock</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}

const TABS = [
  { href: '/business/adviser', label: '★ Adviser' },
  { href: '/business', label: 'Overview' },
  { href: '/business/staff', label: 'Staff' },
  { href: '/business/time', label: 'Hours & rota' },
  { href: '/business/payroll', label: 'Payroll' },
  { href: '/business/bank', label: 'Bank & spending' },
  { href: '/business/stock', label: 'Stock & commitments' },
  { href: '/business/brands', label: 'Brand review' },
];

/**
 * Business sub-navigation, plus the idle lock: while the owner is active the lock is renewed every
 * few minutes; after 15 minutes without activity the page goes back to the unlock screen.
 */
export function BusinessBar({ renew, lock, idleMinutes }: { renew: () => Promise<boolean>; lock: () => Promise<FormState>; idleMinutes: number }) {
  const path = usePathname();
  const router = useRouter();
  const lastActive = useRef(Date.now());
  const lastRenew = useRef(Date.now());
  const [, start] = useTransition();

  useEffect(() => {
    const touch = () => {
      lastActive.current = Date.now();
    };
    const evs = ['mousemove', 'keydown', 'touchstart', 'scroll'] as const;
    evs.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const t = setInterval(async () => {
      const idle = Date.now() - lastActive.current;
      if (idle > idleMinutes * 60_000) {
        router.replace(`/business/unlock?next=${encodeURIComponent(path)}`);
        return;
      }
      if (Date.now() - lastRenew.current > 4 * 60_000 && idle < 4 * 60_000) {
        lastRenew.current = Date.now();
        if (!(await renew())) router.replace(`/business/unlock?next=${encodeURIComponent(path)}`);
      }
    }, 30_000);
    return () => {
      clearInterval(t);
      evs.forEach((e) => window.removeEventListener(e, touch));
    };
  }, [idleMinutes, path, renew, router]);

  const current = TABS.filter((t) => path === t.href || path.startsWith(`${t.href}/`)).sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <div className="biz-bar">
      <nav className="seg viewtabs" aria-label="Business">
        {TABS.map((t) => (
          <Link key={t.href} href={t.href} className={current === t.href ? 'on' : ''} aria-current={current === t.href ? 'page' : undefined} scroll={false}>
            {t.label}
          </Link>
        ))}
      </nav>
      <button type="button" className="btn small" onClick={() => start(async () => void (await lock()))}>
        🔒 Lock
      </button>
    </div>
  );
}

/** A category picker that saves straight away, with "remember for similar". */
export function CategoryPicker({
  value, categories, action,
}: { value: string; categories: readonly string[]; action: (category: string, remember: boolean) => Promise<FormState> }) {
  const [v, setV] = useState(value);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <span className="catpick">
      <select
        value={v}
        disabled={pending}
        aria-label="Category"
        onChange={(e) => {
          const next = e.target.value;
          const remember = window.confirm('Also use this category for similar transactions (past and future)?\n\nOK = all similar · Cancel = just this one');
          setV(next);
          start(async () => {
            const r = await action(next, remember);
            setMsg(r?.error ?? r?.message ?? null);
          });
        }}
      >
        {categories.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      {msg ? <small className="muted">{msg}</small> : null}
    </span>
  );
}

export function StatementUploadForm({ action }: { action: BoundAction }) {
  return (
    <ActionForm action={action} encType="multipart/form-data" resetOnSuccess>
      {(s) => (
        <>
          <div className="fields" style={{ alignItems: 'end' }}>
            <label className={`field${s?.fieldErrors?.file ? ' invalid' : ''}`}>
              <span>Statement CSV *</span>
              <input type="file" name="file" accept=".csv,text/csv" required />
              {s?.fieldErrors?.file ? <span className="err">{s.fieldErrors.file}</span> : <span className="hint">From online banking: Statements → Export / Download → CSV</span>}
            </label>
            <Field state={s} name="accountName" label="Account" placeholder="e.g. Business current account" />
          </div>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 8 }}>
            <Submit pendingText="Reading statement…">Upload statement</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function StockUploadForm({ action, today }: { action: BoundAction; today: string }) {
  return (
    <ActionForm action={action} encType="multipart/form-data" resetOnSuccess>
      {(s) => (
        <>
          <div className="fields" style={{ alignItems: 'end' }}>
            <label className={`field${s?.fieldErrors?.file ? ' invalid' : ''}`}>
              <span>Export file (CSV) *</span>
              <input type="file" name="file" accept=".csv,text/csv" required />
              {s?.fieldErrors?.file ? <span className="err">{s.fieldErrors.file}</span> : <span className="hint">Product export, inventory export, or any stock list with SKU + quantity</span>}
            </label>
            <Field state={s} name="takenOn" label="Stock counted on" type="date" defaultValue={today} hint="For inventory files" />
          </div>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 8 }}>
            <Submit pendingText="Reading file…">Upload</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function FinanceSettingsForm({ action, values }: { action: BoundAction; values: { vatRegistered: boolean; vatStagger: number; vatScheme: string; flatRatePct: number; yearEndMonth: number; limitedCompany: boolean } }) {
  return (
    <ActionForm action={action}>
      {(s) => (
        <>
          <div className="fields three">
            <label className="check">
              <input type="checkbox" name="vatRegistered" defaultChecked={values.vatRegistered} />
              <span>VAT registered</span>
            </label>
            <label className="check">
              <input type="checkbox" name="limitedCompany" defaultChecked={values.limitedCompany} />
              <span>Limited company (pays corporation tax)</span>
            </label>
            <span />
            <Field
              state={s}
              name="vatStagger"
              label="VAT quarters end in"
              defaultValue={String(values.vatStagger)}
              options={[
                { value: '1', label: 'March, June, September, December' },
                { value: '2', label: 'April, July, October, January' },
                { value: '3', label: 'May, August, November, February' },
              ]}
              hint="As on your VAT certificate or HMRC account"
            />
            <Field state={s} name="vatScheme" label="VAT scheme" defaultValue={values.vatScheme} options={[{ value: 'standard', label: 'Standard (reclaim VAT on purchases)' }, { value: 'flat', label: 'Flat rate scheme' }]} />
            <Field state={s} name="flatRatePct" label="Flat rate % (flat rate scheme only)" inputMode="decimal" defaultValue={values.flatRatePct ? String(values.flatRatePct) : ''} />
            <Field state={s} name="yearEndMonth" label="Company year ends at the end of" defaultValue={String(values.yearEndMonth)} options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} hint="Your accounting reference date (Companies House)" />
          </div>
          <FormMessage state={s} />
          <div className="actions" style={{ marginTop: 8 }}>
            <Submit>Save tax settings</Submit>
          </div>
        </>
      )}
    </ActionForm>
  );
}
