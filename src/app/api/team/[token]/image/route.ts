import { findTeamOrder } from '@/lib/services/team-orders';
import { storage } from '@/lib/storage';

/** The garment photo on a team order link (public: anyone with the link sees the page anyway). */
export async function GET(_: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const found = await findTeamOrder(token);
  if (!found?.team.imageKey || !found.team.imageMime) return new Response('Not found', { status: 404 });
  const body = await storage().get(found.team.imageKey);
  return new Response(new Uint8Array(body), {
    headers: {
      'Content-Type': found.team.imageMime,
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}
