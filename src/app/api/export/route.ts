import { asc, eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { customers, orders, users } from '@/db/schema';
import { staffActor, recordEvent } from '@/lib/audit';
import { getStaff, hasRole } from '@/lib/auth';
import { buildExport } from '@/lib/services/backups';
import { paidPence } from '@/lib/services/common';
import { statusLabel } from '@/lib/status';

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  // Neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

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
    const header = ['Order', 'Created', 'Taken by', 'Status', 'Archived', 'Customer', 'Email', 'Phone', 'Brand', 'Product', 'SKU', 'Specification', 'Total (GBP)', 'Paid (GBP)', 'Balance (GBP)', 'ETA', 'Supplier', 'Supplier ref'];
    const lines = [header.join(',')];
    for (const { o, c, takenBy } of rows) {
      const paid = await paidPence(tx, o.id);
      lines.push(
        [o.orderNumber, o.createdAt.toISOString(), takenBy, statusLabel(o.status), o.archivedAt ? 'yes' : '', c.name, c.email, c.phone, o.brand, o.product, o.sku, o.specificationText,
          (o.totalGrossPence / 100).toFixed(2), (paid / 100).toFixed(2), ((o.totalGrossPence - paid) / 100).toFixed(2), o.etaDate ?? '', o.supplier, o.supplierReference]
          .map(csvCell)
          .join(','),
      );
    }
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
