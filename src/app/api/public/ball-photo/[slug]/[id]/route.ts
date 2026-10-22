import { and, eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { printBalls } from '@/db/schema';
import { findDesignShop } from '@/lib/services/ball-printing';
import { storage } from '@/lib/storage';

/** Ball product photos for the public design page. Only active balls of shops with the link switched on. */
export async function GET(_: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
  const shop = await findDesignShop(slug);
  if (!shop) return new Response('Not found', { status: 404 });
  const [b] = await withTenant(shop.org.id, (tx) =>
    tx.select().from(printBalls).where(and(eq(printBalls.id, id), eq(printBalls.active, true))).limit(1),
  );
  if (!b?.photoKey || !b.photoMime) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(await storage().get(b.photoKey)), {
    headers: {
      'Content-Type': b.photoMime,
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}
