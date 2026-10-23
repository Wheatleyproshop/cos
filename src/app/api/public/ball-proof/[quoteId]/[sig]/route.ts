import { eq } from 'drizzle-orm';
import { systemDb } from '@/db';
import { quotes } from '@/db/schema';
import { proofOf } from '@/lib/proofs';
import { fileResponse } from '@/lib/file-response';
import { storage } from '@/lib/storage';
import { safeEqual, signValue } from '@/lib/tokens';

/** The rendered ball / cresting proof shown in approval emails. Authorised by a per-quote HMAC, so it is unguessable. */
export async function GET(_: Request, { params }: { params: Promise<{ quoteId: string; sig: string }> }) {
  const { quoteId, sig } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(quoteId) || !safeEqual(sig, signValue(`ball-proof:${quoteId}`))) {
    return new Response('Not found', { status: 404 });
  }
  const [q] = await systemDb().select({ spec: quotes.specificationJson }).from(quotes).where(eq(quotes.id, quoteId)).limit(1);
  const proof = proofOf(q?.spec);
  if (!proof) return new Response('Not found', { status: 404 });
  return fileResponse(await storage().get(proof.proofKey), proof.mime, proof.kind === 'ball' ? 'golf-ball-proof' : 'cresting-proof');
}
