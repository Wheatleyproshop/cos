import { asc, isNull, sql } from 'drizzle-orm';
import { withTenant } from '@/db';
import { customers, orders, workshopItems, workshopJobs } from '@/db/schema';
import { recordEvent, staffActor } from '@/lib/audit';
import { getStaff, hasRole } from '@/lib/auth';
import { csvRow } from '@/lib/csv';

const gbp = (pence: number) => (pence / 100).toFixed(2);
const day = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : '');

/** Every customer with their orders and workshop history, one row each. Owner/admin only (personal data); audited. */
export async function GET() {
  const staff = await getStaff();
  if (!staff) return new Response('Unauthorised', { status: 401 });
  if (!hasRole(staff, 'admin')) return new Response('Only an owner/admin can export customer data.', { status: 403 });

  const rows = await withTenant(staff.organisationId, async (tx) => {
    const list = await tx
      .select({
        c: customers,
        totalOrders: sql<number>`(select count(*)::int from ${orders} o where o.customer_id = "customers"."id" and o.archived_at is null)`,
        activeOrders: sql<number>`(select count(*)::int from ${orders} o where o.customer_id = "customers"."id" and o.archived_at is null and o.status <> 'collected')`,
        lifetimePence: sql<number>`(select coalesce(sum(o.total_gross_pence), 0)::int from ${orders} o where o.customer_id = "customers"."id" and o.archived_at is null)`,
        lastOrderAt: sql<string | null>`(select max(o.created_at) from ${orders} o where o.customer_id = "customers"."id" and o.archived_at is null)`,
        workshopJobs: sql<number>`(select count(*)::int from ${workshopJobs} w where w.customer_id = "customers"."id" and w.archived_at is null and w.status <> 'cancelled')`,
        openWorkshopJobs: sql<number>`(select count(*)::int from ${workshopJobs} w where w.customer_id = "customers"."id" and w.archived_at is null and w.status in ('checked_in', 'in_progress', 'waiting_parts', 'ready'))`,
        workshopPence: sql<number>`(select coalesce(sum(i.price_pence), 0)::int from ${workshopItems} i join ${workshopJobs} w on w.id = i.job_id
          where w.customer_id = "customers"."id" and w.archived_at is null and w.status <> 'cancelled' and i.removed_at is null)`,
        lastJobRef: sql<string | null>`(select w.reference from ${workshopJobs} w where w.customer_id = "customers"."id" and w.archived_at is null order by w.created_at desc limit 1)`,
        lastJobAt: sql<string | null>`(select max(w.created_at) from ${workshopJobs} w where w.customer_id = "customers"."id" and w.archived_at is null)`,
      })
      .from(customers)
      .where(isNull(customers.archivedAt))
      .orderBy(asc(customers.name));
    await recordEvent(tx, {
      organisationId: staff.organisationId, actor: staffActor(staff), eventType: 'data_exported', entityType: 'organisation',
      entityId: staff.organisationId, metadata: { format: 'csv', report: 'customers', rows: list.length },
    });
    return list;
  });

  const header = [
    'Name', 'Email', 'Phone', 'Notes', 'Customer since',
    'Total orders', 'Active orders', 'Lifetime order value (GBP)', 'Last order',
    'Workshop jobs', 'Open workshop jobs', 'Workshop spend (GBP)', 'Last workshop job', 'Last workshop date',
  ];
  const lines = [csvRow(header)];
  for (const r of rows) {
    lines.push(
      csvRow([
        r.c.name, r.c.email, r.c.phone, r.c.notes, day(r.c.createdAt),
        r.totalOrders, r.activeOrders, gbp(r.lifetimePence), day(r.lastOrderAt),
        r.workshopJobs, r.openWorkshopJobs, gbp(r.workshopPence), r.lastJobRef ?? '', day(r.lastJobAt),
      ]),
    );
  }
  const date = new Date().toISOString().slice(0, 10);
  return new Response('﻿' + lines.join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="customers-${date}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
