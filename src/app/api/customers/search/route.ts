import { and, desc, ilike, isNull, or, sql } from 'drizzle-orm';
import { withTenant } from '@/db';
import { customers } from '@/db/schema';
import { getStaff } from '@/lib/auth';

/** Typeahead for the new order form: returning customers by name, email or phone. */
export async function GET(req: Request) {
  const staff = await getStaff();
  if (!staff || staff.needsMember) return new Response('Unauthorised', { status: 401 });
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim().slice(0, 80);
  if (q.length < 2) return Response.json({ results: [] });
  const term = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  const digits = q.replace(/\D/g, '');
  const results = await withTenant(staff.organisationId, (tx) =>
    tx
      .select({
        id: customers.id,
        name: customers.name,
        email: customers.email,
        phone: customers.phone,
        orders: sql<number>`(select count(*)::int from orders o where o.customer_id = "customers"."id" and o.archived_at is null)`,
      })
      .from(customers)
      .where(
        and(
          isNull(customers.archivedAt),
          or(
            ilike(customers.name, term),
            ilike(customers.email, term),
            ilike(customers.phone, term),
            digits.length >= 4 ? sql`regexp_replace(${customers.phone}, '\\D', '', 'g') like ${'%' + digits + '%'}` : undefined,
          ),
        ),
      )
      .orderBy(desc(customers.updatedAt))
      .limit(8),
  );
  return Response.json({ results }, { headers: { 'Cache-Control': 'no-store' } });
}
