export const DEFAULT_TZ = 'Europe/London';

export function money(pence: number | null | undefined): string {
  const value = (pence ?? 0) / 100;
  return value.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' });
}

/** Parses "529", "529.5", "£1,199.00" → pence. Returns null when invalid. */
export function parseMoneyToPence(input: unknown): number | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim().replace(/[£,\s]/g, '');
  if (s === '') return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const pence = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(pence)) return null;
  return s.startsWith('-') ? -pence : pence;
}

export function penceToInput(pence: number | null | undefined): string {
  return ((pence ?? 0) / 100).toFixed(2);
}

/** YYYY-MM-DD → "23 Oct 2026". */
export function niceDate(isoDate: string | null | undefined, fallback = 'Not set'): string {
  if (!isoDate) return fallback;
  const d = new Date(isoDate + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function longDate(isoDate: string | null | undefined, fallback = 'To be confirmed'): string {
  if (!isoDate) return fallback;
  const d = new Date(isoDate + 'T12:00:00Z');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Timestamp → "14 Oct 2026 · 15:42" in the organisation's timezone. */
export function stamp(ts: Date | string | null | undefined, tz = DEFAULT_TZ): string {
  if (!ts) return '—';
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  return `${day} · ${time}`;
}

/** Today's calendar date (YYYY-MM-DD) in a timezone. */
export function todayInTz(tz = DEFAULT_TZ, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return parts; // en-CA formats as YYYY-MM-DD
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

export function greeting(tz = DEFAULT_TZ, now = new Date()): string {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: tz }).format(now));
  if (hour < 12) return 'Good morning.';
  if (hour < 18) return 'Good afternoon.';
  return 'Good evening.';
}

export function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
