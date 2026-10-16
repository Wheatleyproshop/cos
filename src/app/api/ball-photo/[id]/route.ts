import { eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { printBalls } from '@/db/schema';
import { getStaff } from '@/lib/auth';
import { storage } from '@/lib/storage';

/** Staff-only ball product photo. RLS scopes the ball to the caller's shop. Cached privately: photos change by key. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await getStaff();
  if (!staff) return new Response('Unauthorised', { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
  const [b] = await withTenant(staff.organisationId, (tx) => tx.select().from(printBalls).where(eq(printBalls.id, id)).limit(1));
  if (!b?.photoKey || !b.photoMime) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(await storage().get(b.photoKey)), {
    headers: {
      'Content-Type': b.photoMime,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}
