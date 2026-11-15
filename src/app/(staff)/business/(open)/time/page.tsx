import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionButton } from '@/components/forms';
import { AddEntryForm, EditEntry } from '@/components/time-forms';
import { PageHeader } from '@/components/views';
import { requireBusiness } from '@/lib/business-lock';
import { money, todayInTz } from '@/lib/format';
import { listStaff } from '@/lib/services/business/staff';
import { addDaysIso, rotaBetween, timeEntriesBetween, weekStart, workedMinutes } from '@/lib/services/business/time';
import { addEntryAction, addShiftAction, copyRotaAction, removeEntryAction, removeShiftAction, updateEntryAction } from '../../actions';

export const metadata: Metadata = { title: 'Hours & rota · Business' };

const hm = (m: number) => (m ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : '–');
const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default async function TimePage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const staff = await requireBusiness();
  const tz = staff.org.timezone;
  const sp = await searchParams;
  const today = todayInTz(tz);
  const week = weekStart(sp.week && /^\d{4}-\d{2}-\d{2}$/.test(sp.week) ? sp.week : today);
  const days = Array.from({ length: 7 }, (_, i) => addDaysIso(week, i));
  const [team, entries, rota] = await Promise.all([
    listStaff(staff.organisationId),
    timeEntriesBetween(staff.organisationId, week, addDaysIso(week, 7), tz),
    rotaBetween(staff.organisationId, week, addDaysIso(week, 7)),
  ]);
  const people = team
    .filter((t) => !t.profile?.endDate)
    .map((t) => ({ id: t.id, name: t.name, rate: t.profile?.payType === 'hourly' ? t.profile.hourlyRatePence : 0, salaried: t.profile?.payType === 'salary' }));
  const dayOf = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: tz });
  const t = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  const now = new Date();
  const open = entries.filter((e) => !e.e.clockOut);
  const stale = open.filter((e) => now.getTime() - e.e.clockIn.getTime() > 14 * 3_600_000);
  const grid = people.map((p) => {
    const mine = entries.filter((e) => e.e.userId === p.id);
    const perDay = days.map((d) => mine.filter((e) => dayOf(e.e.clockIn) === d).reduce((n, e) => n + (e.e.clockOut ? workedMinutes(e.e) : 0), 0));
    const total = perDay.reduce((a, b) => a + b, 0);
    return { ...p, perDay, total, cost: Math.round((total / 60) * p.rate) };
  });
  return (
    <>
      <PageHeader staff={staff} title="Hours & rota." sub="Hours worked from the clock-in screen, corrections, and who’s working when." actions={<span />} />
      <div className="weeknav">
        <Link href={`/business/time?week=${addDaysIso(week, -7)}`} className="btn small">
          ← Previous week
        </Link>
        <b>
          Week of {new Date(`${week}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
        </b>
        <Link href={`/business/time?week=${addDaysIso(week, 7)}`} className="btn small">
          Next week →
        </Link>
        {week !== weekStart(today) ? (
          <Link href="/business/time" className="muted">
            This week
          </Link>
        ) : null}
      </div>

      {stale.length ? (
        <div className="notice warn">
          <b>Forgot to clock out?</b> {stale.map((e) => `${e.name} (in since ${t(e.e.clockIn)} ${dayOf(e.e.clockIn)})`).join(', ')} — edit the shift below to add the finish time.
        </div>
      ) : null}

      <section className="panel tablewrap">
        <div className="panel-head">
          <h2>Timesheet</h2>
          {open.length ? <span className="badge ready">In now: {open.map((e) => e.name.split(' ')[0]).join(', ')}</span> : null}
        </div>
        <table className="compact timesheet">
          <thead>
            <tr>
              <th>Name</th>
              {days.map((d, i) => (
                <th key={d} className="num">
                  {DAY[i]} {Number(d.slice(8))}
                </th>
              ))}
              <th className="num">Total</th>
              <th className="num">Pay (est.)</th>
            </tr>
          </thead>
          <tbody>
            {grid.map((g) => (
              <tr key={g.id}>
                <td>
                  <Link href={`/business/staff/${g.id}`}>{g.name}</Link>
                </td>
                {g.perDay.map((m, i) => (
                  <td key={i} className="num">
                    {hm(m)}
                  </td>
                ))}
                <td className="num">
                  <b>{hm(g.total)}</b>
                </td>
                <td className="num">{g.rate ? money(g.cost) : <span className="muted">{g.salaried ? 'salary' : 'no rate'}</span>}</td>
              </tr>
            ))}
            <tr className="totals">
              <td>
                <b>All staff</b>
              </td>
              {days.map((d, i) => (
                <td key={d} className="num">
                  {hm(grid.reduce((n, g) => n + g.perDay[i], 0))}
                </td>
              ))}
              <td className="num">
                <b>{hm(grid.reduce((n, g) => n + g.total, 0))}</b>
              </td>
              <td className="num">
                <b>{money(grid.reduce((n, g) => n + g.cost, 0))}</b>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="panel" style={{ marginTop: 18 }}>
        <h2>Shifts this week</h2>
        {entries.length ? (
          <ul className="attention shiftlist">
            {entries.map(({ e, name }) => (
              <li key={e.id}>
                <span>
                  <b>{name}</b>{' '}
                  <span className="muted">
                    {new Date(`${dayOf(e.clockIn)}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} · {t(e.clockIn)}–{e.clockOut ? t(e.clockOut) : 'still in'}
                    {e.breakMinutes ? ` · ${e.breakMinutes}m break` : ''} · {hm(workedMinutes(e))}
                    {e.source === 'manual' ? ' · added by owner' : ''}
                    {e.note ? ` · ${e.note}` : ''}
                  </span>
                </span>
                <span className="shift-actions">
                  <EditEntry
                    action={updateEntryAction.bind(null, e.id)}
                    values={{ date: dayOf(e.clockIn), start: t(e.clockIn), end: e.clockOut ? t(e.clockOut) : '', breakMinutes: e.breakMinutes, note: e.note }}
                  />
                  <ActionButton action={removeEntryAction.bind(null, e.id)} className="linkbtn danger" confirm="Remove this shift? It stays on the history.">
                    Remove
                  </ActionButton>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No shifts recorded this week.</p>
        )}
        <details className="section" style={{ marginTop: 12 }}>
          <summary>Add a shift someone forgot to clock</summary>
          <AddEntryForm action={addEntryAction} people={people} defaultDate={today < addDaysIso(week, 7) && today >= week ? today : week} />
        </details>
      </section>

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-head">
          <h2>Rota</h2>
          <ActionButton action={copyRotaAction.bind(null, week)} className="btn small">
            Copy last week’s rota
          </ActionButton>
        </div>
        <div className="rota">
          {days.map((d, i) => {
            const shifts = rota.filter((r) => r.s.date === d);
            return (
              <div key={d} className={`rota-day${d === today ? ' today' : ''}`}>
                <b>
                  {DAY[i]} {Number(d.slice(8))}
                </b>
                {shifts.length ? (
                  shifts.map(({ s, name }) => (
                    <div key={s.id} className="rota-shift">
                      <span>
                        {name.split(' ')[0]} <span className="muted">{s.startTime}–{s.endTime}</span>
                      </span>
                      <ActionButton action={removeShiftAction.bind(null, s.id)} className="linkbtn danger">
                        ✕
                      </ActionButton>
                    </div>
                  ))
                ) : (
                  <span className="muted">—</span>
                )}
              </div>
            );
          })}
        </div>
        <details className="section" style={{ marginTop: 12 }}>
          <summary>Add to the rota</summary>
          <AddEntryForm action={addShiftAction} people={people} defaultDate={week} rota />
        </details>
      </section>
    </>
  );
}
