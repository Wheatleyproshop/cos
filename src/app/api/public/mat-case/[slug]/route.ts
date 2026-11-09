import { getMatCasePhoto } from '@/lib/services/mat-engraving';

/** The shop's carry case photo, for the mat engraving builder and the public design page. */
export async function GET(_: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const img = await getMatCasePhoto(slug);
  if (!img) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(img.buf), {
    headers: {
      'Content-Type': img.mime,
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}
