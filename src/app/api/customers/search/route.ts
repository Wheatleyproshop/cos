import { and, desc, ilike, isNull, or, sql } from 'drizzle-orm';
import { withTenant } from '@/db';
import { customers } from '@/db/schema';
import { getStaff } from '@/lib/auth';

/** Typeahead for new orders, quotes, fittings and workshop check-ins: returning customers by name, email or phone. */
export async function GET(req: Request) {
  const staff = await getStaff();
  if (!staff || staff.needsMember) return new Response('Unauthorised', { status: 401 });
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim().slice(0, 80);
  if (q.length < 2) return Response.json({ results: [] });
  const esc = (v: string) => v.replace(/[\\%_]/g, (c) => '\\' + c);
  const term = `%${esc(q)}%`;
  // Every word must appear in the name, in any order: "john sm" and "smith john" both find John Smith.
  const words = q.split(/\s+/).filter(Boolean).slice(0, 5);
  const nameMatch = words.length > 1 ? and(...words.map((w) => ilike(customers.name, `%${esc(w)}%`))) : ilike(customers.name, term);
  const digits = q.replace(/\D/g, '');
  const results = await withTenant(staff.organisationId, (tx) =>
    tx
      .select({
        id: customers.id,
        name: customers.name,
        email: customers.email,
        phone: customers.phone,
        orders: sql<number>`(select count(*)::int from orders o where o.customer_id = "customers"."id" and o.archived_at is null)`,
        workshopJobs: sql<number>`(select count(*)::int from workshop_jobs w where w.customer_id = "customers"."id" and w.archived_at is null and w.status <> 'cancelled')`,
      })
      .from(customers)
      .where(
        and(
          isNull(customers.archivedAt),
          or(
            nameMatch,
            ilike(customers.email, term),
            ilike(customers.phone, term),
            digits.length >= 4 ? sql`regexp_replace(${customers.phone}, '\\D', '', 'g') like ${'%' + digits + '%'}` : undefined,
          ),
        ),
      )
      .orderBy(sql`(${customers.name} ilike ${esc(q) + '%'}) desc`, sql`(${customers.name} ilike ${'% ' + esc(q) + '%'}) desc`, desc(customers.updatedAt))
      .limit(8),
  );
  return Response.json({ results }, { headers: { 'Cache-Control': 'no-store' } });
}
