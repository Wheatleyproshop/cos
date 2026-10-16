'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { FormState } from '@/lib/action-utils';

type Result = { id: string; name: string; email: string; phone: string; orders: number };
export type PickerDefaults = { customerId?: string; customerName?: string; email?: string; phone?: string };

/**
 * Customer name / email / phone for a new order or quote. Typing in the name box searches
 * existing customers; picking one fills their details and links the order to their record.
 */
export function CustomerPicker({ state, defaults }: { state: FormState; defaults: PickerDefaults }) {
  const v = state?.values ?? {};
  const err = state?.fieldErrors ?? {};
  const [customerId, setCustomerId] = useState(v.customerId ?? defaults.customerId ?? '');
  const [name, setName] = useState(v.customerName ?? defaults.customerName ?? '');
  const [email, setEmail] = useState(v.email ?? defaults.email ?? '');
  const [phone, setPhone] = useState(v.phone ?? defaults.phone ?? '');
  const [results, setResults] = useState<Result[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const listId = useId();

  useEffect(() => () => clearTimeout(timer.current), []);

  const search = (q: string) => {
    clearTimeout(timer.current);
    if (customerId || q.trim().length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/customers/search?q=${encodeURIComponent(q.trim())}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { results: Result[] };
        setResults(data.results);
        setActive(0);
        setOpen(data.results.length > 0);
      } catch {
        /* offline — just type details in */
      }
    }, 200);
  };

  const pick = (r: Result) => {
    setCustomerId(r.id);
    setName(r.name);
    setEmail(r.email);
    setPhone(r.phone);
    setOpen(false);
    setResults([]);
  };

  const clear = () => {
    setCustomerId('');
    setName('');
    setEmail('');
    setPhone('');
  };

  return (
    <>
      <input type="hidden" name="customerId" value={customerId} />
      <label className={`field wide${err.customerName ? ' invalid' : ''}`} style={{ position: 'relative' }}>
        <span>Customer name *</span>
        <input
          name="customerName"
          required
          autoComplete="off"
          placeholder="Start typing a name, email or phone to find a returning customer…"
          value={name}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          onChange={(e) => {
            setName(e.target.value);
            search(e.target.value);
          }}
          onKeyDown={(e) => {
            if (!open) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(results[active]);
            } else if (e.key === 'Escape') setOpen(false);
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          readOnly={Boolean(customerId)}
        />
        {customerId ? (
          <span className="returning">
            ✓ Returning customer — details from their record.{' '}
            <button type="button" className="linkbtn" onClick={clear}>
              Not them?
            </button>
          </span>
        ) : err.customerName ? (
          <span className="err">{err.customerName}</span>
        ) : null}
        {open ? (
          <ul className="picker" id={listId} role="listbox">
            {results.map((r, i) => (
              <li key={r.id} role="option" aria-selected={i === active}>
                <button type="button" className={i === active ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(r)}>
                  <b>{r.name}</b>
                  <small>
                    {[r.email, r.phone].filter(Boolean).join(' · ') || 'No contact details'}
                    {r.orders ? ` · ${r.orders} order${r.orders === 1 ? '' : 's'}` : ''}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </label>
      <label className={`field${err.email ? ' invalid' : ''}`}>
        <span>Email address *</span>
        <input name="email" type="email" required autoComplete="off" placeholder="customer@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        {err.email ? <span className="err">{err.email}</span> : customerId && !email ? <span className="hint">Add their email so they get order updates.</span> : null}
      </label>
      <label className="field">
        <span>Phone</span>
        <input name="phone" type="tel" inputMode="tel" placeholder="Mobile number" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </label>
    </>
  );
}
