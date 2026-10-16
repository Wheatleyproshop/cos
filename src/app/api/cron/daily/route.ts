import { safeEqual } from '@/lib/tokens';
import { runDailyJobs } from '@/lib/services/jobs';

export const maxDuration = 300;

/** Vercel Cron: sends `Authorization: Bearer $CRON_SECRET`. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization') ?? '';
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) return new Response('Unauthorised', { status: 401 });
  const summary = await runDailyJobs();
  return Response.json({ ok: true, summary });
}
