import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionButton } from '@/components/forms';
import { PrebookDetailsForm, PrebookLineForm, ReceiveForm } from '@/components/prebook-forms';
import { PageHeader } from '@/components/views';
import { hasRole, requireStaff } from '@/lib/auth';
import { money, stamp } from '@/lib/format';
import { accountLogoUrl, listAccounts } from '@/lib/services/accounts';
import { deletedPrebookNotes, getPrebook, PREBOOK_STATUS_LABELS } from '@/lib/services/prebooks';
import { InternalNotesForm } from '@/components/workshop-forms';
import {
  addPrebookLineAction, archivePrebookAction, deletePrebookAction, prebookStatusAction, receivePrebookAction, removePrebookLineAction, restorePrebookLineAction,
  updatePrebookAction, prebookNotesAction, clearPrebookNotesAction, restorePrebookNotesAction,
} from '../../actions';

export async function generateMetadata({ params }: { params: Promise<{ ref: string }> }): Promise<Metadata> {
  return { title: decodeURIComponent((await params).ref) };
}

const day = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '—');
const tel = (n: string) => `tel:${n.replace(/[^\d+]/g, '')}`;

export default async function PrebookDetail({ params }: { params: Promise<{ ref: string }> }) {
  const staff = await requireStaff();
  const manager = hasRole(staff, 'manager');
  const d = await getPrebook(staff.organisationId, decodeURIComponent((await params).ref));
  if (!d) notFound();
  const { prebook: p, account: a, lines, deletedLines } = d;
  const [accounts, deletedNotes] = await Promise.all([
    manager ? listAccounts(staff.organisationId) : Promise.resolve([]),
    p.notes ? Promise.resolve(null) : deletedPrebookNotes(staff.organisationId, p.id),
  ]);
  const deleted = Boolean(p.removedAt);
  const editable = !deleted && !['delivered', 'cancelled'].includes(p.status) && !p.archivedAt;
  const qty = lines.reduce((s, l) => s + l.quantity, 0);
  const got = lines.reduce((s, l) => s + Math.min(l.quantityReceived, l.quantity), 0);
  const value = lines.reduce((s, l) => s + l.quantity * l.unitCostPence, 0);

  const statusButtons: { to: 'draft' | 'placed' | 'confirmed' | 'cancelled'; label: string; primary?: boolean; confirm?: string }[] = [];
  if (p.status === 'draft') statusButtons.push({ to: 'placed', label: 'Mark as placed with brand', primary: true });
  if (p.status === 'placed') statusButtons.push({ to: 'confirmed', label: 'Mark as confirmed', primary: true }, { to: 'draft', label: 'Back to draft' });
  if (!['delivered', 'cancelled'].includes(p.status)) statusButtons.push({ to: 'cancelled', label: 'Cancel pre-book', confirm: 'Cancel this pre-book? It stays on record as cancelled.' });

  return (
    <>
      <PageHeader
        staff={staff}
        title={`${p.brand} ${p.season}`.trim()}
        sub={`${p.reference}${p.title ? ` · ${p.title}` : ''}`}
        actions={
          <Link href="/prebook" className="btn">
            ← Pre-book
          </Link>
        }
      />

      {deleted ? (
        <div className="notice warn">
          <b>This pre-book was deleted {stamp(p.removedAt!, staff.org.timezone)}</b>
          It’s hidden from the pre-book list, arriving soon, accounts and Performance.
          {manager ? (
            <div style={{ marginTop: 8 }}>
              <ActionButton action={deletePrebookAction.bind(null, p.id, false)} className="btn small">
                Restore pre-book
              </ActionButton>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="pb-status">
        <span className={`badge pb-${p.status}`}>{PREBOOK_STATUS_LABELS[p.status]}</span>
        {p.archivedAt ? <span className="badge">Archived</span> : null}
        <span className="muted">
          {got} of {qty} received · {money(value)} at cost
        </span>
        {manager && !deleted ? (
          <span className="pb-buttons">
            {statusButtons.map((b) => (
              <ActionButton key={b.to} action={prebookStatusAction.bind(null, p.id, b.to)} className={`btn small${b.primary ? ' primary' : ''}`} confirm={b.confirm}>
                {b.label}
              </ActionButton>
            ))}
            {['delivered', 'cancelled'].includes(p.status) ? (
              <ActionButton action={archivePrebookAction.bind(null, p.id, !p.archivedAt)} className="btn small">
                {p.archivedAt ? 'Restore' : 'Archive'}
              </ActionButton>
            ) : null}
          </span>
        ) : null}
      </div>

      <div className="detailgrid">
        <div className="detailbox">
          <small>Delivery window</small>
          <b>
            {p.expectedFrom || p.expectedTo ? `${day(p.expectedFrom)}${p.expectedTo ? ` – ${day(p.expectedTo)}` : ''}` : 'Not set'}
          </b>
        </div>
        <div className="detailbox">
          <small>Supplier reference</small>
          <b>{p.supplierReference || '—'}</b>
          {p.placedOn ? <div className="muted">Placed {day(p.placedOn)}</div> : null}
        </div>
        <div className="detailbox">
          {a && accountLogoUrl(a) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={accountLogoUrl(a)!} alt={`${a.brand} logo`} className="acct-logo small" />
          ) : null}
          <small>{a ? `${a.brand} account` : 'Account'}</small>
          {a ? (
            <>
              <b>{a.accountNumber || 'No account number'}</b>
              <div className="muted">
                {a.repName ? `${a.repName} · ` : ''}
                {a.repPhone ? <a href={tel(a.repPhone)}>{a.repPhone}</a> : null}
                {a.repEmail ? (
                  <>
                    {a.repPhone ? ' · ' : ''}
                    <a href={`mailto:${a.repEmail}?subject=${encodeURIComponent(`${p.reference} ${p.supplierReference}`.trim())}`}>{a.repEmail}</a>
                  </>
                ) : null}
              </div>
              <Link href={`/accounts#acct-${a.id}`} className="muted">
                Full account details
              </Link>
            </>
          ) : (
            <b>Not linked</b>
          )}
        </div>
      </div>
      {p.notes || deletedNotes || (manager && !deleted) ? (
        <div className="notice pb-notes">
          <b>Notes</b>
          {p.notes ? <div style={{ whiteSpace: 'pre-line' }}>{p.notes}</div> : <div className="muted">{deletedNotes ? 'Notes deleted.' : 'None.'}</div>}
          {manager && !deleted ? (
            <div className="note-tools">
              <InternalNotesForm action={prebookNotesAction.bind(null, p.id)} notes={p.notes} placeholder="e.g. Deadline 30 Nov · carriage paid over £500" />
              {p.notes ? (
                <ActionButton action={clearPrebookNotesAction.bind(null, p.id)} className="linkbtn danger" confirm="Delete the notes on this pre-book? You can restore them straight after.">
                  Delete
                </ActionButton>
              ) : deletedNotes ? (
                <ActionButton action={restorePrebookNotesAction.bind(null, p.id)} className="linkbtn">
                  Restore notes
                </ActionButton>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <h2>Lines</h2>
          {['placed', 'confirmed', 'part_delivered'].includes(p.status) ? <span className="muted">Enter how many of each have arrived so far, then save.</span> : null}
        </div>
        {lines.length ? (
          <ReceiveForm
            action={receivePrebookAction.bind(null, p.id)}
            lines={lines}
            canReceive={['placed', 'confirmed', 'part_delivered', 'delivered'].includes(p.status) && !p.archivedAt && !deleted}
            removeButtons={
              manager && editable
                ? Object.fromEntries(
                    lines
                      .filter((l) => l.quantityReceived === 0)
                      .map((l) => [
                        l.id,
                        <ActionButton
                          key={l.id}
                          action={removePrebookLineAction.bind(null, p.id, l.id)}
                          className="btn small danger"
                          confirm={`Delete ${l.product}${l.variant ? ` (${l.variant})` : ''} from this pre-book? You can restore it from Deleted lines.`}
                        >
                          Delete
                        </ActionButton>,
                      ]),
                  )
                : undefined
            }
          />
        ) : (
          <p className="muted">No lines yet. Add what you’re pre-booking below.</p>
        )}
        {manager && editable ? (
          <details className="section" open={!lines.length}>
            <summary>Add a line</summary>
            <PrebookLineForm action={addPrebookLineAction.bind(null, p.id)} />
          </details>
        ) : null}
        {deletedLines.length ? (
          <details className="section">
            <summary>Deleted lines ({deletedLines.length})</summary>
            <ul className="attention">
              {deletedLines.map((l) => (
                <li key={l.id}>
                  <span>
                    <b>{l.product}</b>
                    <div className="muted">
                      {[l.variant, `× ${l.quantity}`, money(l.unitCostPence * l.quantity)].filter(Boolean).join(' · ')} · deleted {stamp(l.removedAt!, staff.org.timezone)}
                    </div>
                  </span>
                  {manager && editable ? (
                    <ActionButton action={restorePrebookLineAction.bind(null, p.id, l.id)} className="btn small">
                      Restore
                    </ActionButton>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      {manager && !p.archivedAt && !deleted ? (
        <section className="panel">
          <details className="section">
            <summary>Edit pre-book details</summary>
            <PrebookDetailsForm
              action={updatePrebookAction.bind(null, p.id)}
              accounts={accounts.map((x) => ({ value: x.id, label: x.accountNumber ? `${x.brand} (${x.accountNumber})` : x.brand }))}
              values={p}
              submitLabel="Save changes"
            />
          </details>
        </section>
      ) : null}
      {manager && !deleted ? (
        <div className="actions">
          <ActionButton
            action={deletePrebookAction.bind(null, p.id, true)}
            className="btn danger"
            confirm={`Delete ${p.reference} (${p.brand})? Use this for pre-books entered by mistake: it disappears from the list, arriving soon and Performance. You can restore it from Deleted pre-books.`}
          >
            Delete pre-book
          </ActionButton>
        </div>
      ) : null}
    </>
  );
}
