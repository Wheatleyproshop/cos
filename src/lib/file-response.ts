/** Serves a stored file with safe headers (no sniffing, sandboxed, never cached). */
export function fileResponse(body: Buffer, mime: string, filename: string) {
  const inline = mime.startsWith('image/') || mime === 'application/pdf';
  return new Response(new Uint8Array(body), {
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
