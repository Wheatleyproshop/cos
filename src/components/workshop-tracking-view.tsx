import type { Organisation, WorkshopStatus } from '@/db/schema';
import { longDate, money, stamp } from '@/lib/format';
import { PublicShell } from './public-shell';
import { BuildTable } from './spec-view';

type Item = { club: string; work: string; parts: string; quantity: number; pricePence: number };
type Job = {
  reference: string; status: WorkshopStatus; etaDate: string | null; createdAt: Date; readyAt: Date | null; collectedAt: Date | null; delayReason: string;
};

const STEPS: { key: WorkshopStatus; label: string }[] = [
  { key: 'checked_in', label: 'Checked in' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'ready', label: 'Ready to collect' },
  { key: 'collected', label: 'Collected' },
];

/** The customer's view of their workshop job: progress, ready date, clubs and what to pay. */
export function WorkshopTrackingView({ org, job: j, items, customerName }: { org: Organisation; job: Job; items: Item[]; customerName: string }) {
  const current = j.status === 'waiting_parts' ? 'in_progress' : j.status;
  const idx = STEPS.findIndex((s) => s.key === current);
  const total = items.reduce((s, i) => s + i.pricePence, 0);
  const build = {
    title: `Workshop job ${j.reference}`,
    totalPence: total,
    lines: items.map((i) => ({ label: i.quantity > 1 ? `${i.club} ×${i.quantity}` : i.club, value: [i.work, i.parts].filter(Boolean).join(' — '), pricePence: i.pricePence })),
  };
  return (
    <PublicShell org={org}>
      <div className="eyebrow">WORKSHOP {j.reference}</div>
      <h1 style={{ fontSize: 26 }}>
        {j.status === 'ready' ? 'Your clubs are ready to collect' : j.status === 'collected' ? 'Your clubs have been collected' : j.status === 'cancelled' ? 'This job was cancelled' : 'Your clubs are in our workshop'}
      </h1>
      <p style={{ marginTop: 0 }}>Hi {customerName.split(' ')[0]}, here’s the latest on your clubs.</p>

      {j.status !== 'cancelled' ? (
        <ol className="steps" aria-label="Workshop progress">
          {STEPS.map((s, i) => (
            <li key={s.key} className={i < idx ? 'done' : i === idx ? 'current' : ''} aria-current={i === idx ? 'step' : undefined}>
              {s.label}
              {s.key === 'in_progress' && j.status === 'waiting_parts' ? ' — waiting for parts' : ''}
            </li>
          ))}
        </ol>
      ) : null}

      {j.status === 'waiting_parts' && j.delayReason ? (
        <div className="notice warn">
          <b>Waiting for parts</b>
          {j.delayReason}
        </div>
      ) : null}

      <div className="detailgrid">
        <div className="detailbox">
          <small>{j.status === 'ready' ? 'Ready since' : j.status === 'collected' ? 'Collected' : 'Estimated ready'}</small>
          <b>
            {j.status === 'ready' && j.readyAt
              ? stamp(j.readyAt, org.timezone)
              : j.status === 'collected' && j.collectedAt
                ? stamp(j.collectedAt, org.timezone)
                : j.etaDate
                  ? longDate(j.etaDate)
                  : 'We’ll confirm shortly'}
          </b>
        </div>
        <div className="detailbox">
          <small>{j.status === 'collected' ? 'Total' : 'To pay on collection'}</small>
          <b>{money(total)}</b>
        </div>
      </div>

      {j.status === 'ready' && org.collectionLocation ? (
        <div className="notice">
          <b>Collect from</b>
          {org.collectionLocation}
          {org.openingHours ? ` · ${org.openingHours}` : ''}
        </div>
      ) : null}

      <h3>Your clubs</h3>
      <BuildTable build={build} />
      <p className="muted">Checked in {stamp(j.createdAt, org.timezone)}. Questions? Just reply to any of our emails or give us a call.</p>
    </PublicShell>
  );
}
