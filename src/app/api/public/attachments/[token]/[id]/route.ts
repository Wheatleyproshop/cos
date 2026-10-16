import { fileResponse } from '@/lib/file-response';
import { findPublicAttachment } from '@/lib/services/public';
import { storage } from '@/lib/storage';

/** Customer-visible files only, authorised by the order's tracking token. */
export async function GET(_: Request, { params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
  const a = await findPublicAttachment(token, id);
  if (!a) return new Response('Not found', { status: 404 });
  return fileResponse(await storage().get(a.storageKey), a.mimeType, a.filename);
}
