import { getStaff } from '@/lib/auth';
import { listNotifications, markNotificationsSeen } from '@/lib/services/notifications';

export async function GET() {
  const staff = await getStaff();
  if (!staff) return new Response('Unauthorised', { status: 401 });
  return Response.json(await listNotifications(staff.organisationId, staff.id), { headers: { 'Cache-Control': 'no-store' } });
}

/** Mark everything as read. Same-origin only. */
export async function POST(req: Request) {
  const staff = await getStaff();
  if (!staff) return new Response('Unauthorised', { status: 401 });
  const origin = req.headers.get('origin');
  if (origin && new URL(origin).host !== req.headers.get('host')) return new Response('Forbidden', { status: 403 });
  await markNotificationsSeen(staff.organisationId, staff.id);
  return Response.json({ ok: true });
}
