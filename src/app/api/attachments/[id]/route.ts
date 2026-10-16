import { eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { attachments } from '@/db/schema';
import { getStaff } from '@/lib/auth';
import { fileResponse } from '@/lib/file-response';
import { storage } from '@/lib/storage';

/** Staff download. RLS guarantees the attachment belongs to the caller's organisation. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await getStaff();
  if (!staff) return new Response('Unauthorised', { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
  const [a] = await withTenant(staff.organisationId, (tx) => tx.select().from(attachments).where(eq(attachments.id, id)).limit(1));
  if (!a) return new Response('Not found', { status: 404 });
  return fileResponse(await storage().get(a.storageKey), a.mimeType, a.filename);
}
