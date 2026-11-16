import { findTeamOrder } from '@/lib/services/team-orders';
import { storage } from '@/lib/storage';

/** A garment photo on a team order link (public: anyone with the link sees the page anyway). */
export async function GET(_: Request, { params }: { params: Promise<{ token: string; item: string }> }) {
  const { token, item } = await params;
  const found = await findTeamOrder(token);
  const it = found?.team.items.find((i) => i.id === item);
  if (!it?.imageKey || !it.imageMime) return new Response('Not found', { status: 404 });
  const body = await storage().get(it.imageKey);
  return new Response(new Uint8Array(body), {
    headers: { 'Content-Type': it.imageMime, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" },
  });
}
