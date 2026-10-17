import { eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { supplierAccounts } from '@/db/schema';
import { getStaff } from '@/lib/auth';
import { storage } from '@/lib/storage';

/** Staff-only brand logo for a supplier account. RLS scopes the account to the caller's shop; URLs change when the logo does. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await getStaff();
  if (!staff) return new Response('Unauthorised', { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
  const [a] = await withTenant(staff.organisationId, (tx) => tx.select().from(supplierAccounts).where(eq(supplierAccounts.id, id)).limit(1));
  if (!a?.logoKey || !a.logoMime) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(await storage().get(a.logoKey)), {
    headers: {
      'Content-Type': a.logoMime,
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}
