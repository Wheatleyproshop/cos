import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  acceptInStoreAction,
  addNoteAction,
  approvalLinkAction,
  archiveAttachmentAction,
  archiveOrderAction,
  deleteOrderAction,
  voidPaymentAction,
  deleteQuoteAction,
  closeQuoteAction,
  createRequestAction,
  editOrderAction,
  editQuoteAction,
  recordPaymentAction,
  sendQuoteAction,
  trackingLinkAction,
  updateProgressAction,
  uploadAttachmentAction,
} from '@/app/(staff)/actions';
import { hasRole, type Staff } from '@/lib/auth';
import { templateName } from '@/lib/audit';
import { PAYMENT_KIND_LABELS } from '@/db/schema';
import { asBallPrintSpec } from '@/lib/ball-print';
import { asCrestSpec, positionOf, type CrestSpec } from '@/lib/cresting';
import { bytes, longDate, money, niceDate, penceToInput, stamp, titleCase } from '@/lib/format';
import { getBrandOptions, getCustomerDetail, getOrderDetail, getQuoteDetail } from '@/lib/queries';
import { canTransition, DEFAULT_WORKFLOW, QUOTE_STATUS_LABELS, statusLabel } from '@/lib/status';
import { CancelButton } from './cancel-button';
import { CloseButton } from './chrome';
import { ActionButton, LinkGenerator } from './forms';
import { AcceptInStoreForm, EditQuoteForm } from './misc-forms';
import { AttachmentForm, CreateRequestForm, EditOrderForm, NoteForm, PaymentForm, ProgressForm, VoidPaymentForm, type RequestDefaults } from './order-forms';
import { SpecView } from './spec-view';
import { Badge, DetailBox, MessageBadge, Timeline } from './views';

/** Ball Printing proof and the customer's original artwork, for staff. */
function CrestProof({ quoteId, spec }: { quoteId: string; spec: CrestSpec }) {
  const base = `/api/cresting/${quoteId}`;
  const logos = [...new Map(spec.placements.flatMap((p) => (p.artwork.type === 'logo' ? [[p.artwork.logo, p.artwork] as const] : []))).values()];
  return (
    <div className="bp-proofbox">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`${base}/proof`} alt={`Proof: ${spec.garment.description}`} className="cr-proof" />
      <div>
        <small>Cresting proof</small>
        <b>
          {spec.garment.description}
          {spec.garment.colour ? ` · ${spec.garment.colour}` : ''} · {spec.quantity} item{spec.quantity === 1 ? '' : 's'}
        </b>
        <div className="muted">{spec.placements.map((p) => `${positionOf(p.position)?.label} (${p.method})`).join(' · ')}</div>
        <div className="actions" style={{ marginTop: 10 }}>
          <a className="btn small" href={`${base}/proof`} target="_blank" rel="noreferrer">
            Open proof
          </a>
          <a className="btn small" href={`${base}/front`} target="_blank" rel="noreferrer">
            Garment photo
          </a>
          {spec.photos.back ? (
            <a className="btn small" href={`${base}/back`} target="_blank" rel="noreferrer">
              Back photo
            </a>
          ) : null}
          {logos.map((l) => (
            <a key={l.logo} className="btn small" href={`${base}/logo-${l.logo + 1}`} download={l.filename}>
              Download {l.filename}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

function BallProof({ quoteId, spec }: { quoteId: string | null; spec: unknown }) {
  const crest = asCrestSpec(spec);
  if (crest && quoteId) return <CrestProof quoteId={quoteId} spec={crest} />;
  const p = asBallPrintSpec(spec);
  if (!p || !quoteId) return null;
  return (
    <div className="bp-proofbox">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/api/ball-print/${quoteId}/proof`} alt={`Proof: ${p.ball.brand} ${p.ball.name}`} width={220} height={220} />
      <div>
        <small>Ball printing proof</small>
        <b>
          {p.ball.brand} {p.ball.name} · {p.dozens} dozen
        </b>
        <div className="muted">
          {p.artwork.type === 'logo' ? 'Customer logo' : `Text: “${p.artwork.lines.join(' / ')}”`}
        </div>
        <div className="actions" style={{ marginTop: 10 }}>
          <a className="btn small" href={`/api/ball-print/${quoteId}/proof`} target="_blank" rel="noreferrer">
            Open proof
          </a>
          {p.artwork.type === 'logo' ? (
            <a className="btn small" href={`/api/ball-print/${quoteId}/logo`} download={p.artwork.filename}>
              Download original logo
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ── Order ───────────────────────────────────────────────────────────── */

export async function OrderDetail({ staff, number, inModal }: { staff: Staff; number: string; inModal: boolean }) {
  const [d, brands] = await Promise.all([getOrderDetail(staff.org, decodeURIComponent(number)), getBrandOptions(staff.organisationId)]);
  if (!d) notFound();
  const { order: o, customer: c } = d;
  const tz = staff.org.timezone;
  const manager = hasRole(staff, 'manager');
  const statusOptions = DEFAULT_WORKFLOW.filter((s) => canTransition(o.status, s.key)).map((s) => ({ value: s.key, label: s.label }));

  return (
    <>
      <div className="modalhead">
        <div>
          <div className="eyebrow">{o.orderNumber} / CUSTOMER ORDER</div>
          <h2>
            {o.brand} {o.product}
          </h2>
        </div>
        <CloseButton fallback="/orders" inModal={inModal} />
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>
        <Badge status={o.status} text={statusLabel(o.status)} />
        {o.removedAt ? <span className="badge">Deleted</span> : o.archivedAt ? <span className="badge">Archived</span> : null}
        <span className="muted" style={{ marginTop: 0 }}>
          <Link href={`/customers/${c.id}`}>{c.name}</Link> · <a href={`mailto:${c.email}`}>{c.email}</a>
          {c.phone ? (
            <>
              {' '}
              · <a href={`tel:${c.phone.replace(/\s/g, '')}`}>{c.phone}</a>
            </>
          ) : null}
        </span>
      </div>

      {d.flags.length ? (
        <div className="notice warn" role="status">
          <b>Needs attention</b>
          {d.flags.map((f) => f.label).join(' · ')}
        </div>
      ) : null}

      <BallProof quoteId={o.quoteId} spec={o.specificationJson} />
      <SpecView json={o.specificationJson} text={o.specificationText} label="Custom specification" />
      <div className="detailgrid">
        <DetailBox label="Product ID">{o.sku || '—'}</DetailBox>
        <DetailBox label="Order value / Paid" sub={`${d.credit ? `Includes ${money(d.credit)} account credit · ` : ''}Balance due: ${money(d.balance)}`}>
          {money(o.totalGrossPence)} / {money(d.paid)}
        </DetailBox>
        <DetailBox label="Current ETA" sub={o.etaReason ? `Customer told: “${o.etaReason}”` : undefined}>
          {niceDate(o.etaDate)}
        </DetailBox>
        <DetailBox label="Order taken by" sub={stamp(o.createdAt, tz)}>
          {d.takenByName}
        </DetailBox>
        <DetailBox label="Supplier reference" sub={o.supplier ? `Supplier: ${o.supplier}` : undefined}>
          {o.supplierReference || 'Not added'}
        </DetailBox>
      </div>
      {d.sourceQuoteNumber ? (
        <p className="muted">
          Created from accepted quote <Link href={`/quotes/${d.sourceQuoteNumber}`}>{d.sourceQuoteNumber}</Link>.
        </p>
      ) : null}
      {o.internalNotes ? (
        <div className="notice" style={{ background: '#f7f8f5', color: '#3b4339' }}>
          <b>Internal notes</b>
          {o.internalNotes}
        </div>
      ) : null}

      {!o.archivedAt ? (
        <>
          <h3>{o.status === 'place_order' ? 'Place this order' : 'Progress'}</h3>
          <ProgressForm
            key={`${o.status}-${o.etaDate}-${o.supplierReference}`}
            action={updateProgressAction.bind(null, o.id)}
            order={{ status: o.status, etaDate: o.etaDate, etaReason: o.etaReason, supplierReference: o.supplierReference }}
            options={statusOptions}
            canSuppress={manager}
            balanceText={money(d.balance)}
            hasBalance={staff.org.paymentTracking && d.balance > 0}
          />
        </>
      ) : null}

      {staff.org.paymentTracking ? (
        <>
      <h3>Payments</h3>
      {d.payments.some(({ p }) => p.kind !== 'void') ? (
        <div className="tablewrap">
          <table className="compact">
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Method</th>
                <th>Recorded by</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {d.payments
                .filter(({ p }) => p.kind !== 'void')
                .map(({ p, by }) => {
                  const voided = d.payments.find((x) => x.p.voidsPaymentId === p.id);
                  const label = `${PAYMENT_KIND_LABELS[p.kind].toLowerCase()} of ${money(p.amountPence)}`;
                  return (
                    <tr key={p.id} className={voided ? 'pay-voided' : undefined}>
                      <td>{stamp(p.createdAt, tz)}</td>
                      <td>
                        <span className="pay-what">{PAYMENT_KIND_LABELS[p.kind]}</span>
                        {p.reference ? <div className="muted">Ref {p.reference}</div> : null}
                        {voided ? (
                          <div className="pay-void-note">
                            Voided by {voided.by} · {stamp(voided.p.createdAt, tz)} — {voided.p.reference}
                          </div>
                        ) : manager && !o.removedAt ? (
                          <div style={{ marginTop: 4 }}>
                            <VoidPaymentForm action={voidPaymentAction.bind(null, o.id, p.id)} label={label} />
                          </div>
                        ) : null}
                      </td>
                      <td>{titleCase(p.method)}</td>
                      <td>{by}</td>
                      <td className="num">
                        <span className="pay-what">{p.kind === 'refund' ? `−${money(p.amountPence)}` : money(p.amountPence)}</span>
                      </td>
                    </tr>
                  );
                })}
              <tr>
                <td colSpan={4}>
                  <b>Total {money(o.totalGrossPence)} · Paid {money(d.paid)}</b>
                </td>
                <td className="num">
                  <b>Balance {money(d.balance)}</b>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No payments recorded. Balance due {money(d.balance)}.</p>
      )}
      {!o.archivedAt ? <PaymentForm action={recordPaymentAction.bind(null, o.id)} canRefund={manager} /> : null}
        </>
      ) : null}

      <h3>Attachments</h3>
      {d.attachments.length ? (
        <ul className="attention">
          {d.attachments.map(({ a, by }) => (
            <li key={a.id}>
              <div>
                <a href={`/api/attachments/${a.id}`} target="_blank" rel="noopener">
                  {a.filename}
                </a>
                <div className="muted">
                  {titleCase(a.category)} · {bytes(a.sizeBytes)} · {a.visibility === 'internal' ? 'Staff only' : 'Customer visible'} · {by},{' '}
                  {stamp(a.createdAt, tz)}
                </div>
              </div>
              <ActionButton action={archiveAttachmentAction.bind(null, a.id)} className="btn small" confirm={`Archive ${a.filename}? It stays in the audit trail.`}>
                Archive
              </ActionButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Attach supplier confirmations, fitting sheets, invoices, screenshots or product photos.</p>
      )}
      {!o.archivedAt ? <AttachmentForm action={uploadAttachmentAction.bind(null, o.id)} /> : null}

      <h3>Customer communication</h3>
      {d.messages.length ? (
        <div className="tablewrap">
          <table className="compact">
            <tbody>
              {d.messages.map((m) => (
                <tr key={m.id}>
                  <td>
                    <Link href={`/emails?view=${m.id}`}>{templateName(m.templateType)}</Link>
                    <div className="muted">to {m.recipient}</div>
                  </td>
                  <td>{stamp(m.createdAt, tz)}</td>
                  <td className="num">
                    <MessageBadge status={m.status} simulated={m.simulated} />
                    {m.error ? <div className="muted">{m.error}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No emails yet.</p>
      )}
      <div style={{ marginTop: 12 }}>
        <LinkGenerator
          action={trackingLinkAction.bind(null, o.id)}
          label="Get customer tracking link"
          note="Read-only page with your branding, status and ETA. Never shows internal notes or supplier details. Shown once — copy it now."
        />
      </div>

      {!o.archivedAt ? (
        <details className="section">
          <summary>Edit product, specification & price</summary>
          <EditOrderForm
            action={editOrderAction.bind(null, o.id)}
            values={{
              brand: o.brand, category: o.category, product: o.product, sku: o.sku, specificationText: o.specificationText, total: penceToInput(o.totalGrossPence),
              supplier: o.supplier, supplierNotes: o.supplierNotes, internalNotes: o.internalNotes,
            }}
            brands={brands}
          />
        </details>
      ) : null}

      <h3>Activity timeline</h3>
      <NoteForm action={addNoteAction.bind(null, o.id)} />
      <Timeline events={d.events} tz={tz} />

      {o.removedAt ? (
        <div className="notice warn">
          <b>This order was deleted {stamp(o.removedAt, tz)}</b>
          It’s left out of order lists, the customer’s history, Performance and exports.
          {manager ? (
            <div style={{ marginTop: 8 }}>
              <ActionButton action={deleteOrderAction.bind(null, o.id, false)} className="btn small">
                Restore order
              </ActionButton>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="actions">
        {manager && !o.removedAt ? (
          <>
            <ActionButton
              action={archiveOrderAction.bind(null, o.id, !o.archivedAt)}
              className="btn"
              confirm={o.archivedAt ? undefined : 'Archive this order? It will be hidden from lists but kept with its full history.'}
            >
              {o.archivedAt ? 'Restore order' : 'Archive order'}
            </ActionButton>
            <ActionButton
              action={deleteOrderAction.bind(null, o.id, true)}
              className="btn danger"
              confirm={`Delete ${o.orderNumber}? Use this for orders entered by mistake: no email is sent, and it’s left out of the customer’s history, Performance and exports. You can restore it from Deleted orders on the All orders page.`}
            >
              Delete order
            </ActionButton>
          </>
        ) : null}
        <Link href={`/orders/new?customer=${c.id}&from=${o.orderNumber}`} className="btn">
          Reorder this build
        </Link>
      </div>
    </>
  );
}

/* ── Quote ───────────────────────────────────────────────────────────── */

export async function QuoteDetail({ staff, number, inModal }: { staff: Staff; number: string; inModal: boolean }) {
  const [d, brands] = await Promise.all([getQuoteDetail(staff.org, decodeURIComponent(number)), getBrandOptions(staff.organisationId)]);
  if (!d) notFound();
  const { quote: q, customer: c } = d;
  const tz = staff.org.timezone;
  const open = ['draft', 'sent'].includes(q.status) && !q.archivedAt;
  const onlineDesign = Boolean((asBallPrintSpec(q.specificationJson) ?? asCrestSpec(q.specificationJson))?.submittedOnline);

  return (
    <>
      <div className="modalhead">
        <div>
          <div className="eyebrow">{q.quoteNumber} / CUSTOMER QUOTE</div>
          <h2>
            {q.brand} {q.product}
          </h2>
        </div>
        <CloseButton fallback="/quotes" inModal={inModal} />
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>
        <Badge status="quote" text={QUOTE_STATUS_LABELS[q.status]} />
        <span className="muted" style={{ marginTop: 0 }}>
          <Link href={`/customers/${c.id}`}>{c.name}</Link> · <a href={`mailto:${c.email}`}>{c.email}</a>
          {c.phone ? ` · ${c.phone}` : ''}
        </span>
      </div>
      {d.flags.length ? <div className="notice warn">{d.flags.map((f) => f.label).join(' · ')}</div> : null}
      {d.convertedOrderNumber ? (
        <div className="notice">
          <b>Approved {q.acceptedAt ? stamp(q.acceptedAt, tz) : ''}{q.acceptedName ? ` by ${q.acceptedName}` : ''}</b>
          Converted to order <Link href={`/orders/${d.convertedOrderNumber}`}>{d.convertedOrderNumber}</Link>.
        </div>
      ) : null}

      {open && onlineDesign ? (
        <div className="notice">
          <b>Designed online by {c.name}</b>
          {asCrestSpec(q.specificationJson)
            ? 'The price covers the cresting only. Add the garment price under Edit quote if you’re supplying them, check the artwork and sizes, then email the proof back for approval or approve it in store.'
            : 'Check the artwork, quantity and price. Approve it in store below to put it into print, or edit it and email a proof back for them to approve.'}
        </div>
      ) : null}
      <BallProof quoteId={q.id} spec={q.specificationJson} />
      <SpecView json={q.specificationJson} text={q.specificationText} label="Custom specification" />
      <div className="detailgrid">
        <DetailBox label="Product ID">{q.sku || '—'}</DetailBox>
        <DetailBox label="Price / Deposit required">
          {money(q.totalGrossPence)} / {money(q.depositRequiredPence)}
        </DetailBox>
        <DetailBox label="Lead time / Valid until">
          {q.estimatedLeadTime || '—'} / {q.validUntil ? longDate(q.validUntil) : 'No expiry'}
        </DetailBox>
        <DetailBox label="Quote created by" sub={stamp(q.createdAt, tz)}>
          {onlineDesign ? `${c.name} (online)` : d.createdByName}
        </DetailBox>
        <DetailBox label="Sent to customer">{q.sentAt ? stamp(q.sentAt, tz) : 'Not sent yet'}</DetailBox>
      </div>

      {open ? (
        <>
          <h3>Customer approval</h3>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <ActionButton action={sendQuoteAction.bind(null, q.id)} className="btn primary">
              {q.status === 'sent' ? 'Re-send approval email' : 'Email approval link'}
            </ActionButton>
            <LinkGenerator
              action={approvalLinkAction.bind(null, q.id)}
              label="Get approval link to share"
              note="Secure, single-use link. Generating a new one revokes earlier links."
            />
          </div>
          <div style={{ marginTop: 16 }}>
            <AcceptInStoreForm action={acceptInStoreAction.bind(null, q.id)} defaultName={c.name} />
          </div>
          <details className="section">
            <summary>Edit quote</summary>
            <EditQuoteForm
              action={editQuoteAction.bind(null, q.id)}
              values={{
                brand: q.brand, category: q.category, product: q.product, sku: q.sku, specificationText: q.specificationText, total: penceToInput(q.totalGrossPence),
                deposit: penceToInput(q.depositRequiredPence), estimatedLeadTime: q.estimatedLeadTime, validUntil: q.validUntil ?? '',
                internalNotes: q.internalNotes,
              }}
              brands={brands}
            />
          </details>
        </>
      ) : null}

      {d.messages.length ? (
        <>
          <h3>Emails</h3>
          <ul className="attention">
            {d.messages.map((m) => (
              <li key={m.id}>
                <span>
                  <Link href={`/emails?view=${m.id}`}>{templateName(m.templateType)}</Link> to {m.recipient}
                  <div className="muted">{stamp(m.createdAt, tz)}</div>
                </span>
                <MessageBadge status={m.status} simulated={m.simulated} />
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h3>Activity timeline</h3>
      <Timeline events={d.events} tz={tz} />

      {open ? (
        <div className="actions">
          <ActionButton action={closeQuoteAction.bind(null, q.id, 'declined')} className="btn" confirm="Mark this quote as declined by the customer?">
            Customer declined
          </ActionButton>
          <ActionButton action={closeQuoteAction.bind(null, q.id, 'cancelled')} className="btn danger" confirm="Cancel this quote? The approval link will stop working.">
            Cancel quote
          </ActionButton>
        </div>
      ) : null}
      {q.archivedAt ? (
        <div className="notice warn">
          <b>This quote was deleted {stamp(q.archivedAt, tz)}</b>
          It’s hidden from quote lists, the customer’s page and Performance, and its approval link no longer works.
          {hasRole(staff, 'manager') ? (
            <div style={{ marginTop: 8 }}>
              <ActionButton action={deleteQuoteAction.bind(null, q.id, false)} className="btn small">
                Restore quote
              </ActionButton>
            </div>
          ) : null}
        </div>
      ) : hasRole(staff, 'manager') && q.status !== 'accepted' ? (
        <div className="actions">
          <ActionButton
            action={deleteQuoteAction.bind(null, q.id, true)}
            className="btn danger"
            confirm={`Delete ${q.quoteNumber}? Use this for quotes entered by mistake: no email is sent, the approval link stops working, and you can restore it from Deleted quotes on the Quotes page.`}
          >
            Delete quote
          </ActionButton>
        </div>
      ) : null}
    </>
  );
}

/* ── New order / quote ───────────────────────────────────────────────── */

export async function NewRequest({
  staff,
  inModal,
  params,
}: {
  staff: Staff;
  inModal: boolean;
  params: { mode?: string; customer?: string; from?: string };
}) {
  const defaults: RequestDefaults = {};
  if (params.customer) {
    const cust = await getCustomerDetail(staff.org, params.customer);
    if (cust) {
      Object.assign(defaults, { customerId: cust.customer.id, customerName: cust.customer.name, email: cust.customer.email, phone: cust.customer.phone });
      const build = params.from ? cust.builds.find((b) => b.orderNumber === params.from) : undefined;
      if (build) Object.assign(defaults, { brand: build.brand, product: build.product, sku: build.sku, specificationText: build.spec });
    }
  }
  const mode = params.mode === 'quote' ? 'quote' : 'order';
  const brands = await getBrandOptions(staff.organisationId);
  return (
    <>
      <div className="modalhead">
        <div>
          <div className="eyebrow">NEW CUSTOMER REQUEST</div>
          <h2>Create an order or quote</h2>
        </div>
        <CloseButton fallback="/" inModal={inModal} />
      </div>
      <CreateRequestForm
        action={createRequestAction}
        staffName={staff.name}
        canSuppress={hasRole(staff, 'manager')}
        initialMode={mode}
        defaults={defaults}
        brands={brands}
        cancel={<CancelLink inModal={inModal} />}
      />
    </>
  );
}

function CancelLink({ inModal }: { inModal: boolean }) {
  return inModal ? <CancelButton /> : (
    <Link href="/" className="btn">
      Cancel
    </Link>
  );
}

