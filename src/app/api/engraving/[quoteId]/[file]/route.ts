import { eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { quotes } from '@/db/schema';
import { getStaff } from '@/lib/auth';
import { fileResponse } from '@/lib/file-response';
import { asMatSpec } from '@/lib/mat-engraving';
import { storage } from '@/lib/storage';

/** Staff download of a mat engraving job's proof or the customer's original logos. RLS scopes the quote to the caller's shop. */
export async function GET(_: Request, { params }: { params: Promise<{ quoteId: string; file: string }> }) {
  const staff = await getStaff();
  if (!staff) return new Response('Unauthorised', { status: 401 });
  const { quoteId, file } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(quoteId) || !/^(proof|logo-[12])$/.test(file)) return new Response('Not found', { status: 404 });
  const [q] = await withTenant(staff.organisationId, (tx) =>
    tx.select({ spec: quotes.specificationJson, number: quotes.quoteNumber }).from(quotes).where(eq(quotes.id, quoteId)).limit(1),
  );
  const spec = asMatSpec(q?.spec);
  if (!spec) return new Response('Not found', { status: 404 });
  if (file === 'proof') {
    const mime = spec.proofKey.endsWith('.png') ? 'image/png' : spec.proofKey.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    return fileResponse(await storage().get(spec.proofKey), mime, `${q!.number}-proof`);
  }
  const n = Number(file.slice(5)) - 1;
  const logo = spec.engravings.map((e) => e.artwork).find((a) => a.type === 'logo' && a.logo === n);
  if (!logo || logo.type !== 'logo') return new Response('Not found', { status: 404 });
  return fileResponse(await storage().get(logo.storageKey), logo.mimeType, logo.filename);
}
