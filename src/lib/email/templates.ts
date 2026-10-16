import type { EmailAutomationKey } from '@/db/schema';
import { longDate, money } from '../format';

/**
 * Retailer-branded transactional emails. Nothing here mentions COS: the
 * customer should only ever see the golf shop's identity.
 */
export type StoreBranding = {
  storeName: string;
  replyToEmail: string;
  collectionLocation: string;
  storePhone: string;
  openingHours: string;
  brandColor: string;
};

export type EmailContext = {
  store: StoreBranding;
  customerName: string;
  reference: string; // order or quote number
  brand: string;
  product: string;
  specification: string;
  totalPence: number;
  paidPence?: number;
  balancePence?: number;
  depositRequiredPence?: number;
  etaDate?: string | null;
  previousEtaDate?: string | null;
  etaReason?: string;
  leadTime?: string;
  validUntil?: string | null;
  actionUrl?: string; // tracking or approval link
};

export type RenderedEmail = { subject: string; html: string; text: string };

export const TEMPLATE_KEYS: EmailAutomationKey[] = [
  'order_confirmation',
  'quote_approval',
  'eta_revised',
  'ready_for_collection',
  'collection_reminder',
];

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function safeColor(c: string) {
  return /^#[0-9a-f]{3,8}$/i.test(c) ? c : '#193b2c';
}

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || 'there';
}

type Block = { label: string; value: string };

function layout(ctx: EmailContext, o: {
  preheader: string;
  heading: string;
  intro: string[];
  rows: Block[];
  cta?: { label: string; url: string };
  outro?: string[];
}): { html: string; text: string } {
  const color = safeColor(ctx.store.brandColor);
  const rowsHtml = o.rows
    .map(
      (r) =>
        `<tr><td style="padding:6px 0;color:#7c837a;font-size:13px;width:42%;vertical-align:top">${esc(r.label)}</td><td style="padding:6px 0;color:#20251f;font-size:13px;font-weight:600">${esc(r.value)}</td></tr>`,
    )
    .join('');
  const contact = [ctx.store.collectionLocation, ctx.store.storePhone, ctx.store.openingHours].filter(Boolean);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(o.heading)}</title></head>
<body style="margin:0;background:#f5f5f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#20251f">
<span style="display:none;max-height:0;overflow:hidden">${esc(o.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f2;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e4e8e2;border-radius:14px;overflow:hidden">
<tr><td style="background:${color};color:#ffffff;text-align:center;padding:28px 20px;font-size:20px;letter-spacing:3px;font-weight:600">${esc(ctx.store.storeName.toUpperCase())}</td></tr>
<tr><td style="padding:28px 28px 8px">
<div style="text-transform:uppercase;letter-spacing:2px;font-size:10px;color:#879085;font-weight:700">${esc(ctx.reference)}</div>
<h1 style="font-size:22px;letter-spacing:-0.4px;margin:8px 0 18px">${esc(o.heading)}</h1>
<p style="font-size:15px;line-height:1.55;margin:0 0 14px">Hi ${esc(firstName(ctx.customerName))},</p>
${o.intro.map((p) => `<p style="font-size:15px;line-height:1.55;margin:0 0 14px;color:#3b4339">${esc(p)}</p>`).join('')}
</td></tr>
<tr><td style="padding:4px 28px 8px"><div style="background:#f7f8f5;border-radius:12px;padding:16px 18px">
<div style="font-weight:700;font-size:15px;margin-bottom:4px">${esc(ctx.brand)} ${esc(ctx.product)}</div>
<div style="color:#5f685e;font-size:13px;line-height:1.5;margin-bottom:10px;white-space:pre-line">${esc(ctx.specification)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowsHtml}</table></div></td></tr>
${o.cta ? `<tr><td style="padding:18px 28px 6px" align="left"><a href="${esc(o.cta.url)}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;padding:13px 20px;border-radius:9px;font-weight:600;font-size:14px">${esc(o.cta.label)}</a></td></tr>` : ''}
<tr><td style="padding:14px 28px 26px">
${(o.outro ?? []).map((p) => `<p style="font-size:14px;line-height:1.55;margin:0 0 12px;color:#3b4339">${esc(p)}</p>`).join('')}
<p style="font-size:14px;line-height:1.55;margin:0;color:#3b4339">Thank you for choosing ${esc(ctx.store.storeName)}.</p>
</td></tr>
<tr><td style="border-top:1px solid #eef0eb;padding:18px 28px;color:#899087;font-size:12px;line-height:1.6">
<strong style="color:#5f685e">${esc(ctx.store.storeName)}</strong><br>${contact.map(esc).join('<br>')}${contact.length ? '<br>' : ''}Questions? Just reply to this email.
</td></tr></table></td></tr></table></body></html>`;

  const text = [
    ctx.store.storeName.toUpperCase(),
    '',
    `${o.heading} (${ctx.reference})`,
    '',
    `Hi ${firstName(ctx.customerName)},`,
    '',
    ...o.intro.flatMap((p) => [p, '']),
    `${ctx.brand} ${ctx.product}`,
    ctx.specification,
    '',
    ...o.rows.map((r) => `${r.label}: ${r.value}`),
    '',
    ...(o.cta ? [`${o.cta.label}: ${o.cta.url}`, ''] : []),
    ...(o.outro ?? []).flatMap((p) => [p, '']),
    `Thank you for choosing ${ctx.store.storeName}.`,
    '',
    '—',
    ctx.store.storeName,
    ...contact,
    'Questions? Just reply to this email.',
  ].join('\n');

  return { html, text };
}

function commercialRows(ctx: EmailContext): Block[] {
  const rows: Block[] = [{ label: 'Order total', value: money(ctx.totalPence) }];
  if (ctx.paidPence !== undefined) rows.push({ label: 'Paid so far', value: money(ctx.paidPence) });
  if (ctx.balancePence !== undefined) rows.push({ label: 'Balance due', value: money(ctx.balancePence) });
  return rows;
}

export function renderEmail(type: EmailAutomationKey, ctx: EmailContext): RenderedEmail {
  const s = ctx.store.storeName;
  switch (type) {
    case 'order_confirmation': {
      const r = layout(ctx, {
        preheader: `Your ${ctx.brand} order is confirmed.`,
        heading: 'Your order is confirmed',
        intro: ['We have received your order and will keep you informed every step of the way.'],
        rows: [...commercialRows(ctx), { label: 'Estimated arrival', value: longDate(ctx.etaDate) }],
        cta: ctx.actionUrl ? { label: 'Track your order', url: ctx.actionUrl } : undefined,
      });
      return { subject: `Order confirmed — ${ctx.brand} ${ctx.product} (${ctx.reference})`, ...r };
    }
    case 'quote_approval': {
      const rows: Block[] = [{ label: 'Price (incl. VAT)', value: money(ctx.totalPence) }];
      if (ctx.depositRequiredPence) rows.push({ label: 'Deposit to proceed', value: money(ctx.depositRequiredPence) });
      if (ctx.leadTime) rows.push({ label: 'Estimated lead time', value: ctx.leadTime });
      if (ctx.validUntil) rows.push({ label: 'Quote valid until', value: longDate(ctx.validUntil) });
      const r = layout(ctx, {
        preheader: `Your personalised quotation from ${s}.`,
        heading: 'Your personalised quotation',
        intro: ['We have prepared your quote. Please review the specification and price, then approve it online and we will place your order.'],
        rows,
        cta: ctx.actionUrl ? { label: 'Review and approve your quote', url: ctx.actionUrl } : undefined,
        outro: ['No account is needed. If anything needs changing, just reply to this email.'],
      });
      return { subject: `Your quote from ${s} — ${ctx.brand} ${ctx.product}`, ...r };
    }
    case 'eta_revised': {
      const rows: Block[] = [];
      if (ctx.previousEtaDate) rows.push({ label: 'Previous estimate', value: longDate(ctx.previousEtaDate) });
      rows.push({ label: 'New estimated arrival', value: longDate(ctx.etaDate) });
      const intro = ['The estimated arrival date for your order has changed. We will continue to keep you updated.'];
      if (ctx.etaReason) intro.push(ctx.etaReason);
      const r = layout(ctx, {
        preheader: `New estimated arrival: ${longDate(ctx.etaDate)}.`,
        heading: 'An update on your order',
        intro,
        rows,
        cta: ctx.actionUrl ? { label: 'Track your order', url: ctx.actionUrl } : undefined,
      });
      return { subject: `Update on your order ${ctx.reference} — new estimated arrival`, ...r };
    }
    case 'ready_for_collection':
    case 'collection_reminder': {
      const reminder = type === 'collection_reminder';
      const rows: Block[] = [{ label: 'Collect from', value: ctx.store.collectionLocation || s }];
      if (ctx.store.openingHours) rows.push({ label: 'Opening hours', value: ctx.store.openingHours });
      rows.push({ label: 'Balance due on collection', value: money(ctx.balancePence ?? 0) });
      const r = layout(ctx, {
        preheader: reminder ? 'Your order is still waiting for you.' : 'Your order is ready to collect.',
        heading: reminder ? 'A friendly reminder — your order is waiting' : 'Your order is ready',
        intro: reminder
          ? ['Your order is ready and waiting for you in store. Pop in whenever suits you.']
          : ['Great news. Your order has arrived and is ready to collect from our store.'],
        rows,
        cta: ctx.actionUrl ? { label: 'View your order', url: ctx.actionUrl } : undefined,
      });
      return {
        subject: reminder ? `Reminder: your order ${ctx.reference} is ready to collect` : `Your order is ready to collect — ${ctx.reference}`,
        ...r,
      };
    }
  }
}
