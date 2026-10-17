import type { EmailAutomationKey } from '@/db/schema';
import { resolveBrand, type BrandTheme } from '../branding';
import { fitSpecText, priceText, type FitSpec } from '../fit-spec';
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
  brandTheme?: BrandTheme | null;
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
  /** Customer account credit applied from the till. */
  creditPence?: number;
  balancePence?: number;
  depositRequiredPence?: number;
  etaDate?: string | null;
  previousEtaDate?: string | null;
  etaReason?: string;
  leadTime?: string;
  validUntil?: string | null;
  actionUrl?: string; // tracking or approval link
  /** A rendered artwork proof (golf ball printing) shown above the specification. */
  previewImageUrl?: string;
  /** Custom Fitting: each club with its details on separate lines (replaces the plain specification). */
  fit?: FitSpec | null;
  /** 'print' = personalised balls from stock sent to the printer, not ordered from a manufacturer. */
  journey?: 'supplier' | 'print';
};

export type RenderedEmail = { subject: string; html: string; text: string };

export const TEMPLATE_KEYS: EmailAutomationKey[] = [
  'order_confirmation',
  'quote_approval',
  'eta_revised',
  'ready_for_collection',
  'collection_reminder',
  'workshop_checked_in',
  'workshop_delayed',
  'workshop_ready',
  'workshop_reminder',
];

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || 'there';
}

type Block = { label: string; value: string };

/** Each club as a heading row, then one row per detail (label · choice · price). */
function fitHtml(fit: FitSpec, c: { ink: string; muted: string; font: string }) {
  const many = fit.builds.length > 1;
  return fit.builds
    .map((bld, i) => {
      const rows = bld.lines
        .map(
          (l) =>
            `<tr><td style="padding:5px 0;color:${c.muted};font-size:12px;width:28%;vertical-align:top">${esc(l.label)}</td><td style="padding:5px 8px 5px 0;color:${c.ink};font-size:13px;vertical-align:top">${esc(l.value)}${l.detail ? `<br><span style="color:${c.muted};font-size:11px">${esc(l.detail)}</span>` : ''}</td><td style="padding:5px 0;color:${c.ink};font-size:13px;text-align:right;white-space:nowrap;vertical-align:top">${esc(priceText(l.pricePence))}</td></tr>`,
        )
        .join('');
      const notes = bld.notes ? `<tr><td style="padding:5px 0;color:${c.muted};font-size:12px;vertical-align:top">Notes</td><td colspan="2" style="padding:5px 0;color:${c.ink};font-size:13px">${esc(bld.notes)}</td></tr>` : '';
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px"><tr><td colspan="2" style="font-family:${c.font};font-weight:600;font-size:16px;color:${c.ink};padding-bottom:6px;border-bottom:1px solid #efede8">${many ? `${i + 1}. ` : ''}${esc(bld.title)}</td><td style="font-weight:600;font-size:14px;color:${c.ink};text-align:right;padding-bottom:6px;border-bottom:1px solid #efede8">${esc(money(bld.totalPence))}</td></tr>${rows}${notes}</table>`;
    })
    .join('') + (fit.notes ? `<div style="color:${c.muted};font-size:13px;line-height:1.55;margin-bottom:10px;white-space:pre-line">${esc(fit.notes)}</div>` : '');
}

function layout(ctx: EmailContext, o: {
  preheader: string;
  heading: string;
  intro: string[];
  rows: Block[];
  cta?: { label: string; url: string };
  outro?: string[];
}): { html: string; text: string } {
  const b = resolveBrand(ctx.store);
  const ink = '#090a11';
  const muted = '#6b6f7b';
  const rowsHtml = o.rows
    .map(
      (r) =>
        `<tr><td style="padding:7px 0;color:${muted};font-size:13px;width:44%;vertical-align:top">${esc(r.label)}</td><td style="padding:7px 0;color:${ink};font-size:13px;font-weight:600">${esc(r.value)}</td></tr>`,
    )
    .join('');
  const contact = [ctx.store.collectionLocation, ctx.store.storePhone, ctx.store.openingHours].filter(Boolean);
  const brandMark = b.logoUrl
    ? `<img src="${esc(b.logoUrl)}" alt="${esc(ctx.store.storeName)}" height="72" style="display:inline-block;height:72px;width:auto;max-width:300px;border:0;outline:none">`
    : `<span style="font-family:${b.headingFont};font-size:22px;letter-spacing:3px;font-weight:600;color:${b.headerText}">${esc(ctx.store.storeName.toUpperCase())}</span>`;
  const home = b.websiteUrl ? `<a href="${esc(b.websiteUrl)}" style="text-decoration:none">${brandMark}</a>` : brandMark;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light only"><title>${esc(o.heading)}</title>
${b.fontsHref ? `<link href="${esc(b.fontsHref)}" rel="stylesheet">` : ''}</head>
<body style="margin:0;background:#f4f4f2;font-family:${b.bodyFont};color:${ink}">
<span style="display:none;max-height:0;overflow:hidden">${esc(o.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e6e4df">
<tr><td style="background:${b.headerBg};text-align:center;padding:14px 20px">${home}</td></tr>
<tr><td style="background:${b.accent};color:${b.accentText};text-align:center;padding:9px 20px;font-size:11px;letter-spacing:2px;text-transform:uppercase">${esc(o.preheader)}</td></tr>
<tr><td style="padding:32px 32px 8px">
<div style="text-transform:uppercase;letter-spacing:2px;font-size:11px;color:${muted};font-weight:600">${esc(ctx.reference)}</div>
<h1 style="font-family:${b.headingFont};font-size:26px;font-weight:600;letter-spacing:-0.2px;margin:8px 0 18px;color:${ink}">${esc(o.heading)}</h1>
<p style="font-size:15px;line-height:1.6;margin:0 0 14px">Hi ${esc(firstName(ctx.customerName))},</p>
${o.intro.map((p) => `<p style="font-size:15px;line-height:1.6;margin:0 0 14px;color:#2b2e38">${esc(p)}</p>`).join('')}
</td></tr>
${ctx.previewImageUrl ? `<tr><td style="padding:6px 32px 14px" align="center"><img src="${esc(ctx.previewImageUrl)}" width="400" alt="Preview of your personalised ${esc(ctx.brand)} ${esc(ctx.product)}" style="display:block;width:100%;max-width:400px;height:auto;border:0;background:#eef0f4"><div style="font-size:11px;color:${muted};margin-top:8px;letter-spacing:0.5px">Preview for approval. Final print colours and position may vary slightly.</div></td></tr>` : ''}
<tr><td style="padding:6px 32px 8px"><div style="border:1px solid #e6e4df;border-left:4px solid ${b.headerBg};padding:18px 20px">
${ctx.fit ? fitHtml(ctx.fit, { ink, muted, font: b.headingFont }) : `<div style="font-family:${b.headingFont};font-weight:600;font-size:17px;margin-bottom:4px;color:${ink}">${esc(ctx.brand)} ${esc(ctx.product)}</div>
<div style="color:${muted};font-size:13px;line-height:1.55;margin-bottom:10px;white-space:pre-line">${esc(ctx.specification)}</div>`}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #efede8">${rowsHtml}</table></div></td></tr>
${o.cta ? `<tr><td style="padding:22px 32px 6px" align="left"><a href="${esc(o.cta.url)}" style="display:inline-block;background:${b.accent};color:${b.accentText};text-decoration:none;padding:14px 24px;border-radius:${b.radius};font-weight:600;font-size:14px;letter-spacing:0.5px">${esc(o.cta.label)}</a></td></tr>` : ''}
<tr><td style="padding:18px 32px 30px">
${(o.outro ?? []).map((p) => `<p style="font-size:14px;line-height:1.6;margin:0 0 12px;color:#2b2e38">${esc(p)}</p>`).join('')}
<p style="font-size:14px;line-height:1.6;margin:0;color:#2b2e38">Thank you for choosing ${esc(ctx.store.storeName)}.</p>
</td></tr>
<tr><td style="background:#f7f6f3;border-top:1px solid #e6e4df;padding:20px 32px;color:${muted};font-size:12px;line-height:1.7">
<strong style="color:${ink}">${esc(ctx.store.storeName)}</strong><br>${contact.map(esc).join('<br>')}${contact.length ? '<br>' : ''}Questions? Just reply to this email.${b.websiteUrl ? `<br><a href="${esc(b.websiteUrl)}" style="color:${ink}">${esc(b.websiteUrl.replace(/^https:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>` : ''}
</td></tr></table></td></tr></table></body></html>`;

  const text = [
    ctx.store.storeName.toUpperCase(),
    '',
    `${o.heading} (${ctx.reference})`,
    '',
    `Hi ${firstName(ctx.customerName)},`,
    '',
    ...o.intro.flatMap((p) => [p, '']),
    ...(ctx.fit ? [fitSpecText(ctx.fit)] : [`${ctx.brand} ${ctx.product}`, ctx.specification]),
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
  if (ctx.creditPence) rows.push({ label: 'Account credit applied', value: money(ctx.creditPence) });
  if (ctx.balancePence !== undefined) rows.push({ label: 'Balance due', value: money(ctx.balancePence) });
  return rows;
}

export function renderEmail(type: EmailAutomationKey, ctx: EmailContext): RenderedEmail {
  const s = ctx.store.storeName;
  const print = ctx.journey === 'print';
  switch (type) {
    case 'order_confirmation': {
      const r = layout(ctx, {
        preheader: print ? 'Your personalised golf balls have gone into print.' : `Your ${ctx.brand} order is confirmed.`,
        heading: print ? 'Your golf balls have gone into print' : 'Your order is confirmed',
        intro: print
          ? ['Thank you for approving your proof. Your personalised golf balls have gone into print, and we’ll let you know as soon as they’re ready to collect.']
          : ['Thank you for your order. It has been placed with the manufacturer, and we’ll let you know as soon as it arrives in store.'],
        rows: [...commercialRows(ctx), { label: print ? 'Estimated ready date' : 'Estimated arrival', value: longDate(ctx.etaDate) }],
        cta: ctx.actionUrl ? { label: 'Track your order', url: ctx.actionUrl } : undefined,
      });
      return { subject: print ? `Your golf balls have gone into print (${ctx.reference})` : `Order confirmed — ${ctx.brand} ${ctx.product} (${ctx.reference})`, ...r };
    }
    case 'quote_approval': {
      const rows: Block[] = [{ label: 'Price (incl. VAT)', value: money(ctx.totalPence) }];
      if (ctx.depositRequiredPence) rows.push({ label: 'Deposit to proceed', value: money(ctx.depositRequiredPence) });
      if (ctx.leadTime) rows.push({ label: 'Estimated lead time', value: ctx.leadTime });
      if (ctx.validUntil) rows.push({ label: 'Quote valid until', value: longDate(ctx.validUntil) });
      const proof = Boolean(ctx.previewImageUrl);
      const r = layout(ctx, {
        preheader: proof ? `Your personalised golf ball proof from ${s}.` : `Your personalised quotation from ${s}.`,
        heading: proof ? 'Your personalised golf balls' : 'Your personalised quotation',
        intro: proof
          ? ['Here is a preview of your personalised golf balls. Please check the artwork, quantity and price, then approve online and we will send them for printing.']
          : ['We have prepared your quote. Please review the specification and price, then approve it online and we will place your order.'],
        rows,
        cta: ctx.actionUrl ? { label: proof ? 'Review and approve your proof' : 'Review and approve your quote', url: ctx.actionUrl } : undefined,
        outro: ['No account is needed. If anything needs changing, just reply to this email.'],
      });
      return { subject: proof ? `Please approve your golf ball proof — ${s}` : `Your quote from ${s} — ${ctx.brand} ${ctx.product}`, ...r };
    }
    case 'eta_revised': {
      const rows: Block[] = [];
      if (ctx.previousEtaDate) rows.push({ label: 'Previous estimate', value: longDate(ctx.previousEtaDate) });
      rows.push({ label: print ? 'New estimated ready date' : 'New estimated arrival', value: longDate(ctx.etaDate) });
      const intro = [print ? 'The date your golf balls will be ready has changed. We will continue to keep you updated.' : 'The estimated arrival date for your order has changed. We will continue to keep you updated.'];
      if (ctx.etaReason) intro.push(ctx.etaReason);
      const r = layout(ctx, {
        preheader: `${print ? 'New estimated ready date' : 'New estimated arrival'}: ${longDate(ctx.etaDate)}.`,
        heading: 'An update on your order',
        intro,
        rows,
        cta: ctx.actionUrl ? { label: 'Track your order', url: ctx.actionUrl } : undefined,
      });
      return { subject: `Update on your order ${ctx.reference} — new estimated ${print ? 'ready date' : 'arrival'}`, ...r };
    }
    case 'workshop_checked_in': {
      const rows: Block[] = [{ label: 'Estimated ready', value: ctx.etaDate ? longDate(ctx.etaDate) : 'We’ll confirm shortly' }];
      if (ctx.totalPence) rows.push({ label: 'Price (pay on collection)', value: money(ctx.totalPence) });
      const r = layout(ctx, {
        preheader: 'Your clubs are with our workshop.',
        heading: 'We’ve checked in your clubs',
        intro: ['Thanks for leaving your clubs with us. Here’s the work we’ll be doing — we’ll email you as soon as they’re ready to collect.'],
        rows,
        cta: ctx.actionUrl ? { label: 'Check your clubs', url: ctx.actionUrl } : undefined,
      });
      return { subject: `Your clubs are in our workshop (${ctx.reference})`, ...r };
    }
    case 'workshop_delayed': {
      const rows: Block[] = [];
      if (ctx.previousEtaDate) rows.push({ label: 'Previous estimate', value: longDate(ctx.previousEtaDate) });
      rows.push({ label: 'New estimated ready date', value: ctx.etaDate ? longDate(ctx.etaDate) : 'We’ll confirm as soon as we can' });
      const intro = ['Your workshop job is taking a little longer than planned. We’re sorry for the wait and will let you know as soon as your clubs are ready.'];
      if (ctx.etaReason) intro.push(ctx.etaReason);
      const r = layout(ctx, { preheader: 'An update on your workshop job.', heading: 'An update on your clubs', intro, rows,
        cta: ctx.actionUrl ? { label: 'Check your clubs', url: ctx.actionUrl } : undefined,
      });
      return { subject: `Update on your workshop job ${ctx.reference}`, ...r };
    }
    case 'workshop_reminder': {
      const rows: Block[] = [{ label: 'Collect from', value: ctx.store.collectionLocation || s }];
      if (ctx.store.openingHours) rows.push({ label: 'Opening hours', value: ctx.store.openingHours });
      if (ctx.totalPence) rows.push({ label: 'To pay on collection', value: money(ctx.totalPence) });
      const r = layout(ctx, {
        preheader: 'Your clubs are still waiting for you.',
        heading: 'A friendly reminder — your clubs are ready',
        intro: ['Your clubs are finished and waiting for you in the shop. Pop in whenever suits you — just reply if you’d like us to hold them a little longer.'],
        rows,
        cta: ctx.actionUrl ? { label: 'Check your clubs', url: ctx.actionUrl } : undefined,
      });
      return { subject: `Reminder: your clubs are ready to collect — ${ctx.reference}`, ...r };
    }
    case 'workshop_ready': {
      const rows: Block[] = [{ label: 'Collect from', value: ctx.store.collectionLocation || s }];
      if (ctx.store.openingHours) rows.push({ label: 'Opening hours', value: ctx.store.openingHours });
      if (ctx.totalPence) rows.push({ label: 'To pay on collection', value: money(ctx.totalPence) });
      const r = layout(ctx, {
        preheader: 'Your clubs are ready to collect.',
        heading: 'Your clubs are ready to collect',
        intro: ['Good news — the work on your clubs is finished and they’re ready to collect from the shop.'],
        rows,
        cta: ctx.actionUrl ? { label: 'Check your clubs', url: ctx.actionUrl } : undefined,
      });
      return { subject: `Your clubs are ready to collect — ${ctx.reference}`, ...r };
    }
    case 'ready_for_collection':
    case 'collection_reminder': {
      const reminder = type === 'collection_reminder';
      const rows: Block[] = [{ label: 'Collect from', value: ctx.store.collectionLocation || s }];
      if (ctx.store.openingHours) rows.push({ label: 'Opening hours', value: ctx.store.openingHours });
      rows.push({ label: 'Balance due on collection', value: money(ctx.balancePence ?? 0) });
      const r = layout(ctx, {
        preheader: reminder ? 'Your order is still waiting for you.' : print ? 'Your personalised golf balls are ready.' : 'Your order has arrived in store.',
        heading: reminder ? 'A friendly reminder — your order is waiting' : print ? 'Your golf balls are ready to collect' : 'Your order has arrived in store',
        intro: reminder
          ? ['Your order is ready and waiting for you in store. Pop in whenever suits you.']
          : print
            ? ['Great news. Your personalised golf balls have been printed and are ready to collect from our store.']
            : ['Great news. Your order has arrived and is ready to collect from our store.'],
        rows,
        cta: ctx.actionUrl ? { label: 'View your order', url: ctx.actionUrl } : undefined,
      });
      return {
        subject: reminder
          ? `Reminder: your order ${ctx.reference} is ready to collect`
          : print
            ? `Your golf balls are ready to collect — ${ctx.reference}`
            : `Your order has arrived in store — ${ctx.reference}`,
        ...r,
      };
    }
  }
}
