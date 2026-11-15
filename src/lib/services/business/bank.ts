import { and, asc, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { withTenant } from '@/db';
import { bankRules, bankStatements, bankTransactions } from '@/db/schema';
import { recordEvent } from '../../audit';
import { BANK_CATEGORIES, BankCsvError, categorise, parseBankCsv, ruleMatchFor } from '../../bank-csv';
import { ServiceError, type Ctx } from '../common';

/** Uploads a statement CSV: each transaction categorised, anything already uploaded skipped. */
export async function uploadBankStatement(ctx: Ctx, file: File, accountName: string) {
  if (!ctx.userId) throw new ServiceError('Sign in again.');
  if (file.size > 5 * 1024 * 1024) throw new ServiceError('That file is too big (5 MB maximum).');
  if (!/\.csv$/i.test(file.name) && !/csv|text/.test(file.type)) throw new ServiceError('Upload the CSV version of your statement (online banking → export → CSV).');
  let txs;
  try {
    txs = parseBankCsv(await file.text());
  } catch (e) {
    if (e instanceof BankCsvError) throw new ServiceError(e.message);
    throw e;
  }
  return withTenant(ctx.org.id, async (tx) => {
    const rules = await tx.select().from(bankRules);
    const dates = txs.map((t) => t.date).sort();
    const [st] = await tx
      .insert(bankStatements)
      .values({ organisationId: ctx.org.id, accountName: accountName.trim().slice(0, 60), fileName: file.name.slice(0, 120), fromDate: dates[0], toDate: dates[dates.length - 1], uploadedByUserId: ctx.userId! })
      .returning();
    let added = 0;
    for (const t of txs) {
      const res = await tx
        .insert(bankTransactions)
        .values({ organisationId: ctx.org.id, statementId: st.id, ...t, category: categorise(t.description, t.amountPence, rules) })
        .onConflictDoNothing()
        .returning({ id: bankTransactions.id });
      added += res.length;
    }
    await tx.update(bankStatements).set({ transactionCount: added, duplicatesSkipped: txs.length - added }).where(eq(bankStatements.id, st.id));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'bank_statement_uploaded', entityType: 'organisation', entityId: ctx.org.id,
      metadata: { statementId: st.id, file: file.name, added, duplicates: txs.length - added, from: dates[0], to: dates[dates.length - 1] },
    });
    return { added, duplicates: txs.length - added, from: dates[0], to: dates[dates.length - 1] };
  });
}

export async function listStatements(orgId: string) {
  return withTenant(orgId, (tx) => tx.select().from(bankStatements).where(isNull(bankStatements.removedAt)).orderBy(desc(bankStatements.createdAt)).limit(50));
}

/** Removes an uploaded statement and its transactions from the figures (kept, hidden, for the record). */
export async function removeStatement(ctx: Ctx, statementId: string) {
  await withTenant(ctx.org.id, async (tx) => {
    const [st] = await tx.select().from(bankStatements).where(eq(bankStatements.id, statementId)).limit(1);
    if (!st || st.removedAt) return;
    await tx.update(bankStatements).set({ removedAt: new Date() }).where(eq(bankStatements.id, statementId));
    // Free its transactions' fingerprints so the same statement can be uploaded again later.
    await tx
      .update(bankTransactions)
      .set({ fingerprint: sql`${bankTransactions.fingerprint} || ':removed:' || ${statementId}` })
      .where(eq(bankTransactions.statementId, statementId));
    await recordEvent(tx, { organisationId: ctx.org.id, actor: ctx.actor, eventType: 'bank_statement_removed', entityType: 'organisation', entityId: ctx.org.id, metadata: { statementId, file: st.fileName } });
  });
}

export async function listTransactions(orgId: string, opts: { from: string; to: string; category?: string; q?: string }) {
  return withTenant(orgId, (tx) =>
    tx
      .select({ t: bankTransactions })
      .from(bankTransactions)
      .innerJoin(bankStatements, eq(bankStatements.id, bankTransactions.statementId))
      .where(
        and(
          isNull(bankStatements.removedAt), gte(bankTransactions.date, opts.from), lt(bankTransactions.date, opts.to),
          opts.category ? eq(bankTransactions.category, opts.category) : undefined,
          opts.q ? sql`${bankTransactions.description} ilike ${`%${opts.q.replace(/[%_]/g, '')}%`}` : undefined,
        ),
      )
      .orderBy(desc(bankTransactions.date), asc(bankTransactions.description))
      .limit(500),
  );
}

/** Money in and out per month and per category. */
export async function bankSummary(orgId: string, from: string, to: string) {
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({ month: sql<string>`to_char(${bankTransactions.date}, 'YYYY-MM')`, category: bankTransactions.category, inP: sql<number>`coalesce(sum(case when ${bankTransactions.amountPence} > 0 then ${bankTransactions.amountPence} else 0 end), 0)::bigint`, outP: sql<number>`coalesce(sum(case when ${bankTransactions.amountPence} < 0 then -${bankTransactions.amountPence} else 0 end), 0)::bigint`, n: sql<number>`count(*)::int` })
      .from(bankTransactions)
      .innerJoin(bankStatements, eq(bankStatements.id, bankTransactions.statementId))
      .where(and(isNull(bankStatements.removedAt), gte(bankTransactions.date, from), lt(bankTransactions.date, to)))
      .groupBy(sql`1`, bankTransactions.category),
  );
  const months = new Map<string, { month: string; inPence: number; outPence: number }>();
  const cats = new Map<string, { category: string; inPence: number; outPence: number; count: number }>();
  for (const r of rows) {
    const inP = Number(r.inP);
    const outP = Number(r.outP);
    // Moving money between your own accounts isn't income or spending.
    if (r.category !== 'Transfers between accounts') {
      const m = months.get(r.month) ?? { month: r.month, inPence: 0, outPence: 0 };
      m.inPence += inP;
      m.outPence += outP;
      months.set(r.month, m);
    }
    const c = cats.get(r.category) ?? { category: r.category, inPence: 0, outPence: 0, count: 0 };
    c.inPence += inP;
    c.outPence += outP;
    c.count += r.n;
    cats.set(r.category, c);
  }
  return {
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    categories: [...cats.values()].sort((a, b) => b.outPence + b.inPence - (a.outPence + a.inPence)),
  };
}

/** Re-categorises a transaction; optionally remembers it for everything similar (past and future). */
export async function setCategory(ctx: Ctx, txId: string, category: string, remember: boolean) {
  if (!(BANK_CATEGORIES as readonly string[]).includes(category)) throw new ServiceError('Pick a category from the list.');
  return withTenant(ctx.org.id, async (tx) => {
    const [t] = await tx.select().from(bankTransactions).where(eq(bankTransactions.id, txId)).limit(1);
    if (!t) throw new ServiceError('Transaction not found.');
    let changed = 1;
    if (remember) {
      const match = ruleMatchFor(t.description);
      if (match.length >= 3) {
        await tx.delete(bankRules).where(sql`lower(${bankRules.match}) = ${match.toLowerCase()}`);
        await tx.insert(bankRules).values({ organisationId: ctx.org.id, match, category });
        const res = await tx
          .update(bankTransactions)
          .set({ category })
          .where(and(sql`${bankTransactions.description} ilike ${`%${match.replace(/[%_]/g, '')}%`}`, sql`sign(${bankTransactions.amountPence}) = sign(${t.amountPence})`))
          .returning({ id: bankTransactions.id });
        changed = res.length;
      }
    }
    await tx.update(bankTransactions).set({ category }).where(eq(bankTransactions.id, txId));
    await recordEvent(tx, {
      organisationId: ctx.org.id, actor: ctx.actor, eventType: 'bank_category_changed', entityType: 'organisation', entityId: ctx.org.id,
      oldValue: { category: t.category }, newValue: { category }, metadata: { txId, remember, changed },
    });
    return changed;
  });
}

/** Months and years that have bank transactions, newest first (for the compare pickers). */
export async function bankPeriods(orgId: string) {
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({ m: sql<string>`to_char(${bankTransactions.date}, 'YYYY-MM')` })
      .from(bankTransactions)
      .innerJoin(bankStatements, eq(bankStatements.id, bankTransactions.statementId))
      .where(isNull(bankStatements.removedAt))
      .groupBy(sql`1`)
      .orderBy(sql`1 desc`),
  );
  const months = rows.map((r) => r.m);
  return { months, years: [...new Set(months.map((m) => m.slice(0, 4)))] };
}

/** One period's money in/out by category against another's. Periods are [from, to). */
export async function compareBank(orgId: string, a: { from: string; to: string }, b: { from: string; to: string }) {
  const [x, y] = await Promise.all([bankSummary(orgId, a.from, a.to), bankSummary(orgId, b.from, b.to)]);
  const cats = new Map<string, { category: string; aIn: number; aOut: number; bIn: number; bOut: number }>();
  for (const [side, s] of [['a', x], ['b', y]] as const) {
    for (const c of s.categories) {
      const g = cats.get(c.category) ?? { category: c.category, aIn: 0, aOut: 0, bIn: 0, bOut: 0 };
      if (side === 'a') {
        g.aIn += c.inPence;
        g.aOut += c.outPence;
      } else {
        g.bIn += c.inPence;
        g.bOut += c.outPence;
      }
      cats.set(c.category, g);
    }
  }
  const tot = (s: typeof x) => ({ in: s.months.reduce((n, m) => n + m.inPence, 0), out: s.months.reduce((n, m) => n + m.outPence, 0) });
  return {
    a: tot(x), b: tot(y), bHasData: y.categories.length > 0,
    rows: [...cats.values()].filter((c) => c.category !== 'Transfers between accounts').sort((p, q) => q.aOut + q.aIn - (p.aOut + p.aIn)),
  };
}
