import { approveAndInvoiceAction, markPaidInStoreAction, sendOrderInvoiceAction } from '@/app/(staff)/actions';
import { ActionButton } from './forms';
import type { Quote } from '@/db/schema';
import { asBallPrintSpec } from '@/lib/ball-print';
import { money, stamp } from '@/lib/format';
import { invoiceMode } from '@/lib/shopify-admin';
import type { DraftOrderInput } from '@/lib/shopify-invoice';
import { invoiceCompanions, latestInvoiceForQuote, payStateOf } from '@/lib/services/shopify-invoices';
import { ApproveInvoiceForm, MarkPaidInStoreForm } from './misc-forms';

const shopifyAdminDraftUrl = (gid: string | null) => {
  const id = gid?.split('/').pop();
  const store = (process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP || '').replace(/\.myshopify\.com$/, '').trim();
  return id && store ? `https://admin.shopify.com/store/${store}/draft_orders/${id}` : null;
};

function PayloadView({ input }: { input: DraftOrderInput }) {
  return (
    <div>
      <table className="table" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th align="left">Line</th>
            <th>Qty</th>
            <th align="right">Each</th>
          </tr>
        </thead>
        <tbody>
          {input.lineItems.map((l, i) => (
            <tr key={i}>
              <td>
                {'variantId' in l ? (
                  <>
                    Shopify product <code>{l.variantId.split('/').pop()}</code> ({l.customAttributes.map((a) => a.value).join(', ')})
                  </>
                ) : (
                  <>
                    {l.title} <span className="muted">(custom line)</span>
                  </>
                )}
              </td>
              <td align="center">{l.quantity}</td>
              <td align="right">{'variantId' in l ? 'Shopify price' : `£${l.originalUnitPriceWithCurrency.amount}`}</td>
            </tr>
          ))}
          {input.appliedDiscount ? (
            <tr>
              <td>Discount: {input.appliedDiscount.title}</td>
              <td />
              <td align="right">−£{input.appliedDiscount.value.toFixed(2)}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <details>
        <summary className="muted">Exact data for Shopify</summary>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{JSON.stringify(input, null, 2)}</pre>
      </details>
    </div>
  );
}

/** Pay before print on the quote screen: the invoice's state, or the "Approve and send invoice" button. */
export async function InvoicePanel({ orgId, quote, email, name, tz }: { orgId: string; quote: Quote; email: string; name: string; tz: string }) {
  if (!asBallPrintSpec(quote.specificationJson)) return null;
  const latest = await latestInvoiceForQuote(orgId, quote.id);
  const state = latest ? payStateOf(latest) : null;
  const open = ['draft', 'sent'].includes(quote.status) && !quote.archivedAt;

  if (latest && state && (state.status === 'awaiting_payment' || state.status === 'paid')) {
    const admin = shopifyAdminDraftUrl(latest.draftOrderId);
    return (
      <>
        <h3>Pay before print</h3>
        <div className={`notice${state.overdue ? ' warn' : ''}`}>
          <b>{state.label}</b>
          {state.status === 'paid'
            ? `Paid ${state.paidAt ? stamp(state.paidAt, tz) : ''} on Shopify order ${state.shopifyOrderName ?? ''} (${money(state.totalPence)}). ${
                state.deliveryMethod === 'delivery' ? `To post: ${state.deliveryLabel}. Print before posting.` : state.deliveryMethod === 'collection' ? 'Collecting from the shop.' : (state.deliveryLabel ?? '')
              }`
            : `Shopify invoice ${latest.draftOrderName ?? ''} for ${money(state.totalPence)} emailed ${state.sentAt ? stamp(state.sentAt, tz) : ''}. Printing starts once it’s paid.`}
          {state.overdue ? ' Not paid after 3 days: give the customer a call or resend the invoice from Shopify.' : ''}
          <div style={{ marginTop: 6, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {admin ? (
              <a href={admin} target="_blank" rel="noreferrer">
                Open in Shopify
              </a>
            ) : null}
            {latest.invoiceUrl && state.status !== 'paid' ? (
              <a href={latest.invoiceUrl} target="_blank" rel="noreferrer">
                Customer’s payment link
              </a>
            ) : null}
          </div>
          {state.warnings.length ? <div className="muted">{state.warnings.join(' ')}</div> : null}
        </div>
        {state.status === 'awaiting_payment' && open ? (
          <details className="section">
            <summary>Paid at the till instead?</summary>
            <MarkPaidInStoreForm action={markPaidInStoreAction.bind(null, quote.id)} defaultName={name} total={money(quote.totalGrossPence)} />
            <div className="muted">Then delete draft order {latest.draftOrderName} in Shopify so they aren’t asked to pay twice.</div>
          </details>
        ) : null}
      </>
    );
  }
  if (!open) return null;

  const companions = await invoiceCompanions(orgId, quote);
  const live = invoiceMode() === 'live';
  return (
    <>
      <h3>Pay before print</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Happy with the logo and proof? Approve it here and Shopify emails {email || 'the customer'} an invoice; at checkout they choose Royal Mail or click & collect. It’s printed once they pay (“Paid – ready to print”).
        {live ? '' : ' Test mode is on: nothing is sent to Shopify or the customer until SHOPIFY_INVOICES is set to “live”.'}
      </p>
      <ApproveInvoiceForm
        action={approveAndInvoiceAction.bind(null, quote.id)}
        companions={companions.map((c) => ({ ...c, total: money(c.totalPence) }))}
        live={live}
        email={email}
      />
      <details className="section" style={{ marginTop: 12 }}>
        <summary>Paying at the till? Mark paid in store / skip invoice</summary>
        <MarkPaidInStoreForm action={markPaidInStoreAction.bind(null, quote.id)} defaultName={name} total={money(quote.totalGrossPence)} />
      </details>
      {latest && state?.status === 'dry_run' ? (
        <div className="detailbox" style={{ marginTop: 12 }}>
          <small>
            Last test invoice ({stamp(latest.createdAt, tz)}): customer pays <b>{money(latest.totalPence)}</b>
            {latest.cosTotalPence !== latest.totalPence ? ` (COS quotes add up to ${money(latest.cosTotalPence)}; the multi-buy across them saves the difference)` : ''}
          </small>
          {latest.warnings.length ? (
            <div className="notice warn">
              {latest.warnings.map((w) => (
                <div key={w}>{w}</div>
              ))}
            </div>
          ) : null}
          <PayloadView input={latest.payload as DraftOrderInput} />
        </div>
      ) : null}
      {latest && state?.status === 'cancelled' ? <div className="muted">An earlier invoice attempt didn’t go through and was cancelled.</div> : null}
    </>
  );
}

/** On the print job (order): paid on Shopify, which order, and whether it's posted or collected. */
export async function OrderPaidNotice({ orgId, quoteId, tz }: { orgId: string; quoteId: string; tz: string }) {
  const inv = await latestInvoiceForQuote(orgId, quoteId);
  if (inv?.status !== 'paid') return null;
  const post = inv.deliveryMethod === 'delivery';
  return (
    <div className="notice">
      <b>Paid – ready to print · Shopify order {inv.shopifyOrderName}</b>
      Paid {inv.paidAt ? stamp(inv.paidAt, tz) : ''} ({money(inv.totalPence)}).{' '}
      {post
        ? `Royal Mail / post: ${inv.deliveryLabel}. Print first, then fulfil it from Click & Drop (it's tagged personalised-print).`
        : inv.deliveryMethod === 'collection'
          ? 'Collecting from the shop.'
          : 'Delivery or collection not stated on the Shopify order: check it in Shopify.'}
    </div>
  );
}

/** On an approved but unpaid ball-design order (e.g. approved before pay-before-print): send a Shopify invoice. */
export async function OrderInvoiceButton({ orgId, quoteId, orderId, unpaid }: { orgId: string; quoteId: string; orderId: string; unpaid: boolean }) {
  if (!unpaid) return null;
  const inv = await latestInvoiceForQuote(orgId, quoteId);
  if (inv?.status === 'awaiting_payment') {
    return (
      <div className="notice warn">
        <b>Awaiting payment</b>
        Shopify invoice {inv.draftOrderName} for {money(inv.totalPence)} sent. Hold printing until it’s paid.
      </div>
    );
  }
  if (inv?.status === 'paid') return null;
  const live = invoiceMode() === 'live';
  return (
    <div className="notice warn">
      <b>Not paid yet</b>
      This design should be paid before printing. Send the customer a Shopify invoice (they choose Royal Mail or click & collect at checkout).
      <div style={{ marginTop: 8 }}>
        <ActionButton
          action={sendOrderInvoiceAction.bind(null, orderId)}
          className="btn small primary"
          confirm={live ? 'Have Shopify email this customer an invoice for what’s owed?' : 'Test mode: work out the Shopify invoice only. Nothing is sent. Carry on?'}
        >
          {live ? 'Send Shopify invoice' : 'Send Shopify invoice (test mode)'}
        </ActionButton>
      </div>
    </div>
  );
}
