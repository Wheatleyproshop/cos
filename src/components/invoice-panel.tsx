import { approveAndInvoiceAction } from '@/app/(staff)/actions';
import type { Quote } from '@/db/schema';
import { asBallPrintSpec } from '@/lib/ball-print';
import { money, stamp } from '@/lib/format';
import { invoiceMode } from '@/lib/shopify-admin';
import type { DraftOrderInput } from '@/lib/shopify-invoice';
import { invoiceCompanions, latestInvoiceForQuote, payStateOf } from '@/lib/services/shopify-invoices';
import { ApproveInvoiceForm } from './misc-forms';

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
export async function InvoicePanel({ orgId, quote, email, tz }: { orgId: string; quote: Quote; email: string; tz: string }) {
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
            ? `Paid ${state.paidAt ? stamp(state.paidAt, tz) : ''} on Shopify order ${state.shopifyOrderName ?? ''} (${money(state.totalPence)}).`
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
        Happy with the logo and proof? Approve it here and Shopify emails {email || 'the customer'} an invoice. Once they pay, it moves to “Paid – ready to print”.
        {live ? '' : ' Test mode is on: nothing is sent to Shopify or the customer until SHOPIFY_INVOICES is set to “live”.'}
      </p>
      <ApproveInvoiceForm
        action={approveAndInvoiceAction.bind(null, quote.id)}
        companions={companions.map((c) => ({ ...c, total: money(c.totalPence) }))}
        live={live}
        email={email}
      />
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
