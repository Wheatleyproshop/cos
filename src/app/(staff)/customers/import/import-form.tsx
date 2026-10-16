'use client';

import Link from 'next/link';
import { useActionState, useRef, useState } from 'react';
import { importCustomersAction, type ImportState } from './actions';

const LABELS: Record<string, string> = { name: 'Name', first: 'First name', last: 'Last name', email: 'Email', phone: 'Phone', notes: 'Notes' };

export function ImportForm() {
  const [state, action, pending] = useActionState<ImportState, FormData>(importCustomersAction, null);
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  if (state?.stage === 'done') {
    const r = state.result;
    return (
      <div className="notice" role="status">
        <b>Import complete</b>
        {r.created} new customer{r.created === 1 ? '' : 's'} added · {r.updated} existing updated · {r.unchanged} already up to date
        {r.duplicatesInFile ? ` · ${r.duplicatesInFile} duplicate rows ignored` : ''}
        {r.skipped ? ` · ${r.skipped} rows skipped` : ''}.
        <div style={{ marginTop: 10 }}>
          <Link href="/customers" className="btn small">
            View customers
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form action={action}>
      <input type="hidden" name="csv" value={csv} />
      <div className="inline-form">
        <label className="field" style={{ flexBasis: 320 }}>
          <span>Customer file (.csv)</span>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              setFileName(f?.name ?? '');
              setCsv(f ? await f.text() : '');
            }}
          />
        </label>
        <button className="btn" type="submit" disabled={pending || !csv} name="confirm" value="no">
          {pending ? 'Reading…' : 'Preview import'}
        </button>
      </div>

      {state?.stage === 'error' ? (
        <div className="notice error" role="alert">
          {state.error}
        </div>
      ) : null}

      {state?.stage === 'preview' ? (
        <div style={{ marginTop: 16 }}>
          <div className="notice">
            <b>Ready to import {fileName}</b>
            {state.result.created} new · {state.result.updated} existing customers will have missing details filled in · {state.result.unchanged} already up to date
            {state.result.duplicatesInFile ? ` · ${state.result.duplicatesInFile} duplicate rows ignored` : ''}
            {state.result.skipped ? ` · ${state.result.skipped} rows skipped (no name or email${state.skippedLines.length ? `: lines ${state.skippedLines.join(', ')}` : ''})` : ''}.
          </div>
          <p className="muted">
            Columns found:{' '}
            {Object.entries(state.columns)
              .map(([k, v]) => `${LABELS[k] ?? k} ← “${v}”`)
              .join(' · ')}
          </p>
          <div className="tablewrap">
            <table className="compact">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {state.sample.map((r, i) => (
                  <tr key={i}>
                    <td>{r.name}</td>
                    <td>{r.email || <span className="muted">none</span>}</td>
                    <td>{r.phone || '—'}</td>
                    <td className="muted">{r.notes.slice(0, 60)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">First {state.sample.length} rows shown. Existing customer details are never overwritten.</p>
          <div className="actions left">
            <button className="btn primary" type="submit" name="confirm" value="yes" disabled={pending}>
              {pending ? 'Importing…' : `Import ${state.result.created + state.result.updated} customers →`}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setCsv('');
                setFileName('');
                if (fileRef.current) fileRef.current.value = '';
              }}
            >
              Choose a different file
            </button>
          </div>
        </div>
      ) : null}
    </form>
  );
}
