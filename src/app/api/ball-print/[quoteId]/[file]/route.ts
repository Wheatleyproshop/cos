import { eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { quotes } from '@/db/schema';
import { getStaff } from '@/lib/auth';
import { asBallPrintSpec } from '@/lib/ball-print';
import { fileResponse } from '@/lib/file-response';
import { storage } from '@/lib/storage';

/** Staff download of a print job's proof or the customer's original logo. RLS scopes the quote to the caller's shop. */
export async function GET(_: Request, { params }: { params: Promise<{ quoteId: string; file: string }> }) {
  const staff = await getStaff();
  if (!staff) return new Response('Unauthorised', { status: 401 });
  const { quoteId, file } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(quoteId) || !['proof', 'logo'].includes(file)) return new Response('Not found', { status: 404 });
  const [q] = await withTenant(staff.organisationId, (tx) =>
    tx.select({ spec: quotes.specificationJson, number: quotes.quoteNumber }).from(quotes).where(eq(quotes.id, quoteId)).limit(1),
  );
  const spec = asBallPrintSpec(q?.spec);
  if (!spec) return new Response('Not found', { status: 404 });
  if (file === 'logo') {
    if (spec.artwork.type !== 'logo') return new Response('Not found', { status: 404 });
    return fileResponse(await storage().get(spec.artwork.storageKey), spec.artwork.mimeType, spec.artwork.filename);
  }
  const mime = spec.proofKey.endsWith('.png') ? 'image/png' : spec.proofKey.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  return fileResponse(await storage().get(spec.proofKey), mime, `${q!.number}-proof`);
}
