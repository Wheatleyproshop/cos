import { eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { customers } from '@/db/schema';
import { recordEvent } from '../audit';
import { parseCsv } from '../csv';
import { requireRole, ServiceError, type Ctx } from './common';

export const MAX_IMPORT_ROWS = 10_000;

/** Header names we recognise (lower-cased, punctuation stripped). */
const HEADERS: Record<'name' | 'first' | 'last' | 'email' | 'phone' | 'notes', string[]> = {
  // Club membership systems export names as "Title/Forename/Surname"; prefer that over "Surname/Title/Forename".
  name: ['name', 'fullname', 'customer', 'customername', 'contact', 'contactname', 'accountname', 'membername', 'titleforenamesurname', 'forenamesurname'],
  first: ['firstname', 'forename', 'givenname', 'first'],
  last: ['lastname', 'surname', 'familyname', 'last'],
  email: ['email', 'emailaddress', 'e-mail', 'mail'],
  phone: ['phone', 'mobile', 'mobilenumber', 'telephonemobile', 'mobiletelephone', 'mobileno', 'telephone', 'tel', 'phonenumber', 'cell', 'mobilephone', 'contactnumber'],
  notes: ['notes', 'note', 'comments', 'comment', 'memo'],
};

const norm = (h: string) => h.toLowerCase().replace(/[^a-z-]/g, '');
/** Digits for matching, with UK +44 numbers compared as their 0… form. */
const digitsOf = (p: string) => {
  const d = p.replace(/\D/g, '');
  return d.startsWith('44') && d.length === 12 ? `0${d.slice(2)}` : d;
};

const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'mst', 'master', 'mx', 'dr', 'rev', 'revd', 'sir', 'dame', 'lady', 'lord', 'prof', 'capt', 'col', 'maj']);

/** "Mr John Smith" → "John Smith". Leaves a lone word alone. */
export function tidyName(raw: string) {
  const words = raw.replace(/\s+/g, ' ').trim().split(' ');
  if (words.length > 1 && TITLES.has(words[0].toLowerCase().replace(/\.$/, ''))) words.shift();
  return words.join(' ');
}

/** UK numbers as 07700 900111; anything else (notes like "- dad", overseas) kept as typed, spaces tidied. */
export function tidyPhone(raw: string) {
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!/^[+\d\s()-]+$/.test(t)) return t;
  let d = t.replace(/\D/g, '');
  if (d.startsWith('44') && d.length === 12) d = `0${d.slice(2)}`;
  else if (d.length === 10 && d.startsWith('7')) d = `0${d}`;
  return d.length === 11 && d.startsWith('0') ? `${d.slice(0, 5)} ${d.slice(5)}` : t;
}

export type ImportRow = { name: string; email: string; phone: string; notes: string };
export type ImportPlan = {
  columns: Partial<Record<keyof typeof HEADERS, string>>;
  rows: ImportRow[];
  skipped: { line: number; reason: string }[];
};

/** Reads the CSV and maps its columns. Throws a friendly error if it can't find a name column. */
export function planImport(csvText: string): ImportPlan {
  const table = parseCsv(csvText);
  if (table.length < 2) throw new ServiceError('That file has no customer rows. Export a CSV with a header row first.');
  const header = table[0].map(norm);
  const find = (k: keyof typeof HEADERS) => {
    const i = header.findIndex((h) => HEADERS[k].includes(h));
    return i === -1 ? undefined : i;
  };
  const idx = { name: find('name'), first: find('first'), last: find('last'), email: find('email'), phone: find('phone'), notes: find('notes') };
  if (idx.name === undefined && idx.first === undefined && idx.last === undefined) {
    throw new ServiceError(`Couldn’t find a name column. Found: ${table[0].join(', ')}. Rename one to “Name” (or “First name” / “Last name”).`);
  }
  if (table.length - 1 > MAX_IMPORT_ROWS) throw new ServiceError(`That file has ${table.length - 1} rows; import up to ${MAX_IMPORT_ROWS.toLocaleString('en-GB')} at a time.`);

  const columns: ImportPlan['columns'] = {};
  for (const [k, i] of Object.entries(idx)) if (i !== undefined) columns[k as keyof typeof HEADERS] = table[0][i];

  const rows: ImportRow[] = [];
  const skipped: ImportPlan['skipped'] = [];
  const cell = (r: string[], i?: number) => (i === undefined ? '' : (r[i] ?? '').trim());
  table.slice(1).forEach((r, n) => {
    const name = tidyName(cell(r, idx.name) || [cell(r, idx.first), cell(r, idx.last)].filter(Boolean).join(' ')).slice(0, 120);
    let email = cell(r, idx.email).toLowerCase();
    const phone = tidyPhone(cell(r, idx.phone)).slice(0, 40);
    const notes = cell(r, idx.notes).slice(0, 4000);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) email = '';
    if (!name && !email) return skipped.push({ line: n + 2, reason: 'no name or email' });
    rows.push({ name: name || email.split('@')[0], email, phone, notes });
  });
  return { columns, rows, skipped };
}

export type ImportResult = { created: number; updated: number; unchanged: number; duplicatesInFile: number; skipped: number };

/**
 * Adds new customers and fills gaps on existing ones (matched by email, then phone).
 * Never overwrites details already in COS.
 */
export async function importCustomers(ctx: Ctx, csvText: string, opts: { dryRun: boolean }): Promise<ImportResult & { plan: ImportPlan }> {
  requireRole(ctx, 'manager', 'import customers');
  const plan = planImport(csvText);
  return withTenant(ctx.org.id, async (tx) => {
    const existing = await tx.select().from(customers);
    const byEmail = new Map(existing.filter((c) => c.email).map((c) => [c.email.toLowerCase(), c]));
    const byPhone = new Map(existing.filter((c) => digitsOf(c.phone).length >= 7).map((c) => [digitsOf(c.phone), c]));
    // Rows with neither email nor phone can only match an existing customer who also has no contact details.
    const byNameOnly = new Map(existing.filter((c) => !c.email && !c.phone).map((c) => [c.name.toLowerCase(), c]));
    const seen = new Set<string>();
    const result: ImportResult = { created: 0, updated: 0, unchanged: 0, duplicatesInFile: 0, skipped: plan.skipped.length };
    const toInsert: (typeof customers.$inferInsert)[] = [];

    for (const r of plan.rows) {
      const key = r.email || (digitsOf(r.phone).length >= 7 ? `tel:${digitsOf(r.phone)}` : `name:${r.name.toLowerCase()}`);
      if (seen.has(key)) {
        result.duplicatesInFile++;
        continue;
      }
      seen.add(key);
      const hasContact = Boolean(r.email) || digitsOf(r.phone).length >= 7;
      const match =
        (r.email && byEmail.get(r.email)) ||
        (digitsOf(r.phone).length >= 7 && byPhone.get(digitsOf(r.phone))) ||
        (!hasContact && byNameOnly.get(r.name.toLowerCase())) ||
        null;
      if (match) {
        const patch: Partial<typeof customers.$inferInsert> = {};
        if (!match.email && r.email && !byEmail.has(r.email)) patch.email = r.email;
        if (!match.phone && r.phone) patch.phone = r.phone;
        if (!match.notes && r.notes) patch.notes = r.notes;
        if (Object.keys(patch).length) {
          result.updated++;
          if (!opts.dryRun) await tx.update(customers).set({ ...patch, updatedAt: new Date() }).where(eq(customers.id, match.id));
        } else result.unchanged++;
        continue;
      }
      result.created++;
      toInsert.push({ organisationId: ctx.org.id, name: r.name, email: r.email, phone: r.phone, notes: r.notes });
      if (r.email) byEmail.set(r.email, { email: r.email } as never);
    }

    if (!opts.dryRun) {
      for (let i = 0; i < toInsert.length; i += 500) await tx.insert(customers).values(toInsert.slice(i, i + 500));
      await recordEvent(tx, {
        organisationId: ctx.org.id, actor: ctx.actor, eventType: 'customers_imported', entityType: 'organisation', entityId: ctx.org.id,
        newValue: { ...result }, metadata: { columns: plan.columns },
      });
    }
    return { ...result, plan };
  });
}
