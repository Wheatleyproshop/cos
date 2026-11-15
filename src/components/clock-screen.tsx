'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import type { ClockResult } from '@/app/clock/actions';

type Person = { id: string; name: string; inSince: string | null };

const since = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** Tap your name, enter your PIN: clocked in (or out). Resets itself after a few seconds. */
export function ClockScreen({ people, storeName, action }: { people: Person[]; storeName: string; action: (userId: string, pin: string) => Promise<ClockResult> }) {
  const router = useRouter();
  const [who, setWho] = useState<Person | null>(null);
  const [pin, setPin] = useState('');
  const [result, setResult] = useState<ClockResult | null>(null);
  const [pending, start] = useTransition();
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Back to the name list after a result, or after 30 seconds idle on the PIN pad.
  useEffect(() => {
    if (!result && !who) return;
    const t = setTimeout(() => {
      setWho(null);
      setPin('');
      setResult(null);
    }, result?.ok ? 4000 : result ? 5000 : 30000);
    return () => clearTimeout(t);
  }, [result, who, pin]);

  const submit = (p: string) => {
    if (!who) return;
    start(async () => {
      const r = await action(who.id, p);
      setResult(r);
      setPin('');
      if (r.ok) router.refresh();
    });
  };
  const press = (d: string) => {
    if (pending) return;
    setResult(null);
    if (d === '⌫') return setPin((p) => p.slice(0, -1));
    if (d === '✓') return pin.length >= 4 && submit(pin);
    setPin((p) => (p.length < 6 ? p + d : p));
  };

  return (
    <div className="clock">
      <header className="clock-head">
        <div>
          <p>{storeName}</p>
          <h1>Clock in / out</h1>
        </div>
        <div className="clock-now" suppressHydrationWarning>
          <b>{now ? now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '--:--'}</b>
          <span>{now ? now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : ''}</span>
        </div>
      </header>

      {result?.ok ? (
        <div className={`clock-done ${result.action}`} role="status">
          <b>{result.action === 'in' ? `Hi ${result.name.split(' ')[0]}!` : `See you, ${result.name.split(' ')[0]}!`}</b>
          <span>
            {result.action === 'in'
              ? `Clocked in at ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
              : `Clocked out · ${Math.floor(result.minutes / 60)}h ${String(result.minutes % 60).padStart(2, '0')}m today`}
          </span>
        </div>
      ) : who ? (
        <div className="clock-pad">
          <button type="button" className="clock-back" onClick={() => (setWho(null), setPin(''), setResult(null))}>
            ← Not {who.name.split(' ')[0]}?
          </button>
          <h2>
            {who.name} — {who.inSince ? 'clock out' : 'clock in'}
          </h2>
          <div className="clock-dots" aria-label={`${pin.length} digits entered`}>
            {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
              <i key={i} className={i < pin.length ? 'on' : ''} />
            ))}
          </div>
          {result && !result.ok ? (
            <p className="clock-err" role="alert">
              {result.error}
            </p>
          ) : (
            <p className="muted">Enter your PIN</p>
          )}
          <div className="clock-keys">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'].map((d) => (
              <button key={d} type="button" onClick={() => press(d)} disabled={pending || (d === '✓' && pin.length < 4)} className={d === '✓' ? 'go' : ''} aria-label={d === '⌫' ? 'Delete' : d === '✓' ? 'Enter' : d}>
                {d === '✓' ? (pending ? '…' : 'OK') : d}
              </button>
            ))}
          </div>
        </div>
      ) : people.length ? (
        <div className="clock-people">
          {people.map((p) => (
            <button key={p.id} type="button" className={`clock-person${p.inSince ? ' in' : ''}`} onClick={() => setWho(p)}>
              <b>{p.name}</b>
              <span>{p.inSince ? `In since ${since(p.inSince)}` : 'Not in'}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="clock-empty">
          <p>No one can clock in yet. The owner sets each person’s PIN in Business → Staff.</p>
        </div>
      )}
      <footer className="clock-foot">
        <Link href="/">← Back to COS</Link>
      </footer>
    </div>
  );
}
