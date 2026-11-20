import { eq } from 'drizzle-orm';
import { systemDb } from '@/db';
import { quotes } from '@/db/schema';
import { asBallPrintSpec } from '@/lib/ball-print';
import { fileResponse } from '@/lib/file-response';
import { storage } from '@/lib/storage';
import { safeEqual, signValue } from '@/lib/tokens';

/** The customer's original logo, linked from the Shopify invoice so staff can open it from the order. Authorised by a per-quote HMAC. */
export async function GET(_: Request, { params }: { params: Promise<{ quoteId: string; sig: string }> }) {
  const { quoteId, sig } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(quoteId) || !safeEqual(sig, signValue(`ball-logo:${quoteId}`))) return new Response('Not found', { status: 404 });
  const [q] = await systemDb().select({ spec: quotes.specificationJson }).from(quotes).where(eq(quotes.id, quoteId)).limit(1);
  const spec = asBallPrintSpec(q?.spec);
  if (spec?.artwork.type !== 'logo') return new Response('Not found', { status: 404 });
  return fileResponse(await storage().get(spec.artwork.storageKey), spec.artwork.mimeType, spec.artwork.filename);
}
