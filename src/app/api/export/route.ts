import { asc, eq, isNull } from 'drizzle-orm';
import { withTenant } from '@/db';
import { customers, orders, users, workshopItems, workshopJobs } from '@/db/schema';
import { staffActor, recordEvent } from '@/lib/audit';
import { getStaff, hasRole } from '@/lib/auth';
import { csvCell } from '@/lib/csv';
import { buildExport } from '@/lib/services/backups';
import { paidPence } from '@/lib/services/common';
import { statusLabel } from '@/lib/status';
import { WORKSHOP_STATUS_LABELS } from '@/lib/workshop-constants';

export async function GET(req: Request) {
  const staff = await getStaff();
  if (!staff) return new Response('Unauthorised', { status: 401 });
  if (!hasRole(staff, 'admin')) return new Response('Only an owner/admin can export data.', { status: 403 });
  const format = new URL(req.url).searchParams.get('format') === 'csv' ? 'csv' : 'json';
  const date = new Date().toISOString().slice(0, 10);

  const body = await withTenant(staff.organisationId, async (tx) => {
    await recordEvent(tx, {
      organisationId: staff.organisationId, actor: staffActor(staff), eventType: 'data_exported', entityType: 'organisation',
      entityId: staff.organisationId, metadata: { format },
    });
    if (format === 'json') return JSON.stringify(await buildExport(tx, staff.organisationId), null, 2);
    const rows = await tx
      .select({ o: orders, c: customers, takenBy: users.name })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .innerJoin(users, eq(users.id, orders.takenByUserId))
      .orderBy(asc(orders.createdAt));
    const jobs = await tx
      .select({ j: workshopJobs, c: customers, takenBy: users.name })
      .from(workshopJobs)
      .innerJoin(customers, eq(customers.id, workshopJobs.customerId))
      .innerJoin(users, eq(users.id, workshopJobs.takenByUserId))
      .where(isNull(workshopJobs.archivedAt))
      .orderBy(asc(workshopJobs.createdAt));
    const items = jobs.length ? await tx.select().from(workshopItems).where(isNull(workshopItems.removedAt)).orderBy(asc(workshopItems.createdAt)) : [];
    const header = ['Type', 'Order', 'Created', 'Taken by', 'Status', 'Archived', 'Customer', 'Email', 'Phone', 'Brand', 'Product', 'SKU', 'Specification', 'Total (GBP)', 'Paid (GBP)', 'Balance (GBP)', 'ETA', 'Supplier', 'Supplier ref'];
    const out: { at: Date; cells: unknown[] }[] = [];
    for (const { o, c, takenBy } of rows) {
      const paid = await paidPence(tx, o.id);
      out.push({
        at: o.createdAt,
        cells: ['Order', o.orderNumber, o.createdAt.toISOString(), takenBy, statusLabel(o.status), o.archivedAt ? 'yes' : '', c.name, c.email, c.phone, o.brand, o.product, o.sku, o.specificationText,
          (o.totalGrossPence / 100).toFixed(2), (paid / 100).toFixed(2), ((o.totalGrossPence - paid) / 100).toFixed(2), o.etaDate ?? '', o.supplier, o.supplierReference],
      });
    }
    // Workshop jobs share the sheet; they're paid at the till, so paid/balance are left blank.
    for (const { j, c, takenBy } of jobs) {
      const mine = items.filter((i) => i.jobId === j.id);
      const total = mine.reduce((s, i) => s + i.pricePence, 0);
      const clubs = mine.reduce((s, i) => s + i.quantity, 0);
      out.push({
        at: j.createdAt,
        cells: ['Workshop job', j.reference, j.createdAt.toISOString(), takenBy, WORKSHOP_STATUS_LABELS[j.status], j.archivedAt ? 'yes' : '', c.name, c.email, c.phone, 'Workshop',
          `${clubs} club${clubs === 1 ? '' : 's'}`, '', mine.map((i) => `${i.quantity > 1 ? `${i.club} x${i.quantity}` : i.club}: ${[i.work, i.parts].filter(Boolean).join(' — ')}`).join('; '),
          (total / 100).toFixed(2), '', '', j.etaDate ?? '', '', ''],
      });
    }
    out.sort((a, b) => a.at.getTime() - b.at.getTime());
    const lines = [header.join(','), ...out.map((r) => r.cells.map(csvCell).join(','))];
    return lines.join('\n');
  });

  return new Response(body, {
    headers: {
      'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json',
      'Content-Disposition': `attachment; filename="${staff.org.slug}-${format === 'csv' ? 'orders' : 'export'}-${date}.${format}"`,
      'Cache-Control': 'no-store',
    },
  });
}
