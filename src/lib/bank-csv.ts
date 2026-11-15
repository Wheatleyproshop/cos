import { createHash } from 'node:crypto';
import { parseCsv } from './csv';

/**
 * Reads a bank statement CSV from any UK bank: finds the date, description and amount columns
 * (a single signed Amount, or separate Paid in / Paid out), copes with £ signs, commas, brackets
 * and CR/DR, and day-first dates. Returns transactions with money in positive, out negative.
 */

export type ParsedTx = { date: string; description: string; amountPence: number; balancePence: number | null; fingerprint: string };

const norm = (h: string) => h.toLowerCase().replace(/[^a-z]/g, '');
const find = (headers: string[], names: string[]) => headers.findIndex((h) => names.includes(norm(h)));

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

export function parseBankDate(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; // UK banks: day first
  }
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,4})[a-z]*[\s-](\d{2,4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

export function parseBankAmount(raw: string): number | null {
  let s = raw.trim();
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  if (/\bDR$/i.test(s)) {
    sign = -1;
    s = s.replace(/\s*DR$/i, '');
  }
  s = s.replace(/\s*CR$/i, '').replace(/[£,\s]/g, '');
  if (s.startsWith('-')) {
    sign *= -1;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return sign * Math.round(Number(s) * 100);
}

export class BankCsvError extends Error {}

export function parseBankCsv(text: string): ParsedTx[] {
  const table = parseCsv(text.replace(/^﻿/, '')).filter((r) => r.some((c) => c.trim()));
  // Some banks put account details above the real header row: use the first row that has a date column.
  const headerAt = table.findIndex((r) => r.some((c) => /date/i.test(c)));
  if (headerAt < 0) throw new BankCsvError('Couldn’t find a Date column. Download the statement as CSV from online banking and try again.');
  const headers = table[headerAt];
  const iDate = find(headers, ['date', 'transactiondate', 'postingdate', 'completeddate', 'valuedate', 'startedate']);
  const iDesc = find(headers, ['description', 'transactiondescription', 'details', 'narrative', 'name', 'payee', 'memo', 'reference', 'counterparty', 'merchant']);
  const iDesc2 = find(headers, ['reference', 'memo', 'notes', 'type', 'transactiontype']);
  const iAmount = find(headers, ['amount', 'value', 'amountgbp', 'transactionamount', 'amountinr']);
  const iIn = find(headers, ['paidin', 'moneyin', 'credit', 'creditamount', 'in', 'receipts']);
  const iOut = find(headers, ['paidout', 'moneyout', 'debit', 'debitamount', 'out', 'payments', 'withdrawals']);
  const iBal = find(headers, ['balance', 'runningbalance', 'balancegbp']);
  if (iDate < 0 || iDesc < 0 || (iAmount < 0 && iIn < 0 && iOut < 0)) {
    throw new BankCsvError(`Couldn’t recognise the columns (found: ${headers.join(', ')}). It needs a date, a description and an amount (or paid in / paid out).`);
  }
  const out: ParsedTx[] = [];
  const seen = new Map<string, number>();
  for (const r of table.slice(headerAt + 1)) {
    const date = parseBankDate(r[iDate] ?? '');
    if (!date) continue; // totals rows, blank lines, footers
    let amount: number | null = null;
    if (iAmount >= 0) amount = parseBankAmount(r[iAmount] ?? '');
    else {
      const pin = parseBankAmount(r[iIn] ?? '') ?? 0;
      const pout = parseBankAmount(r[iOut] ?? '') ?? 0;
      amount = Math.abs(pin) - Math.abs(pout);
    }
    if (amount === null || amount === 0) continue;
    const description = [r[iDesc], iDesc2 >= 0 && iDesc2 !== iDesc ? r[iDesc2] : ''].map((x) => (x ?? '').trim()).filter(Boolean).join(' · ').replace(/\s+/g, ' ').slice(0, 300);
    const balance = iBal >= 0 ? parseBankAmount(r[iBal] ?? '') : null;
    const base = `${date}|${amount}|${description.toLowerCase()}|${balance ?? ''}`;
    // Two genuinely identical transactions on one day (no running balance) are told apart by their order in the file.
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ date, description: description || '(no description)', amountPence: amount, balancePence: balance, fingerprint: createHash('sha256').update(`${base}|${n}`).digest('hex') });
  }
  if (!out.length) throw new BankCsvError('No transactions found in that file.');
  return out;
}

/* ───────────────────────────── Categories ───────────────────────────── */

export const BANK_CATEGORIES = [
  'Card & online takings', 'Cash & cheques paid in', 'Other income', 'Stock & suppliers', 'Wages', 'HMRC (VAT, PAYE)', 'Rent & rates',
  'Utilities', 'Insurance', 'Software & subscriptions', 'Marketing & advertising', 'Bank & card fees', 'Loans & finance', 'Vehicle & travel',
  'Repairs & equipment', 'Refunds to customers', 'Transfers between accounts', 'Owner drawings', 'Other spending', 'Uncategorised',
] as const;
export type BankCategory = (typeof BANK_CATEGORIES)[number];

const IN_RULES: [RegExp, BankCategory][] = [
  [/sumup|zettle|izettle|square|worldpay|stripe|shopify|paypal|dojo|takepayments|barclaycard|lloyds cardnet|global payments|klarna|clearpay/i, 'Card & online takings'],
  [/cash|chq|cheque|counter credit|deposit/i, 'Cash & cheques paid in'],
  [/transfer|trf|tfr|from a\/c|internal/i, 'Transfers between accounts'],
];
const OUT_RULES: [RegExp, BankCategory][] = [
  [/hmrc|vat |paye|h\.m\.r\.c/i, 'HMRC (VAT, PAYE)'],
  [/acushnet|titleist|footjoy|callaway|taylormade|taylor made|ping|karsten|mizuno|cobra|puma|srixon|dunlop|cleveland|nike|under armour|adidas|motocaddy|powakaddy|glenmuir|lyle & scott|boss|hugo|ecco|skechers|garmin|bushnell|odyssey|scotty|golf pride|lamkin|superstroke|ogio|travismathew|g\/fore|pxg|wilson|bridgestone|sunderland|proquip|galvin green|oscar jacobson|abacus/i, 'Stock & suppliers'],
  [/salary|wages|payroll|pay run/i, 'Wages'],
  [/rent|rates|council|landlord|golf club rent/i, 'Rent & rates'],
  [/british gas|edf|octopus|eon|e\.on|ovo|scottish power|sse|water|thames|severn|electric|energy|bt group|bt\.com|virgin media|sky |vodafone|o2|ee limited|three/i, 'Utilities'],
  [/insurance|aviva|axa|hiscox|zurich|direct line|simply business/i, 'Insurance'],
  [/shopify|google|microsoft|apple\.com|adobe|xero|quickbooks|sage|vercel|resend|dropbox|zoom|canva|mailchimp|klaviyo|openai|anthropic|twilio/i, 'Software & subscriptions'],
  [/facebook|meta|instagram|google ads|tiktok|marketing|advert/i, 'Marketing & advertising'],
  [/fee|charge|commission|interest|overdraft/i, 'Bank & card fees'],
  [/loan|finance|lease|funding circle|iwoca|bounce back/i, 'Loans & finance'],
  [/fuel|petrol|shell|bp |esso|texaco|parking|train|trainline|uber|dvla/i, 'Vehicle & travel'],
  [/screwfix|toolstation|b&q|wickes|amazon|currys|argos/i, 'Repairs & equipment'],
  [/refund/i, 'Refunds to customers'],
  [/transfer|trf|tfr|to a\/c|internal/i, 'Transfers between accounts'],
];

export function categorise(description: string, amountPence: number, rules: { match: string; category: string }[] = []): string {
  const d = description.toLowerCase();
  const own = rules.find((r) => r.match && d.includes(r.match.toLowerCase()));
  if (own) return own.category;
  for (const [re, cat] of amountPence > 0 ? IN_RULES : OUT_RULES) if (re.test(description)) return cat;
  return amountPence > 0 ? 'Other income' : 'Other spending';
}

/** A sensible "anything like this" match for a description: the merchant part, without card numbers and dates. */
export function ruleMatchFor(description: string) {
  return description
    .split(' · ')[0]
    .replace(/\b(card|pos|dd|so|bp|fpi|fpo|bgc|deb|cr|dr|vis|contactless|payment to|payment from)\b/gi, ' ')
    .replace(/\d{2}[/.-]\d{2}([/.-]\d{2,4})?/g, ' ')
    .replace(/\b\d{4,}\b|\*+\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}
