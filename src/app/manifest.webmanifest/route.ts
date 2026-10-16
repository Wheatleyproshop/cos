/**
 * Staff web-app manifest: lets COS be installed to the Mac Dock (Safari "Add to Dock",
 * Chrome/Edge "Install") and the iPhone/iPad Home Screen. Only linked from staff pages,
 * so customer-facing pages never carry COS branding.
 */
export function GET() {
  return Response.json(
    {
      name: 'COS — Customer Order System',
      short_name: 'COS',
      description: 'Customer orders, quotes and custom fitting for golf retail.',
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#172b23',
      theme_color: '#172b23',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      ],
      shortcuts: [
        { name: 'New order', url: '/orders/new' },
        { name: 'Custom Fitting', url: '/fitting' },
      ],
    },
    { headers: { 'Content-Type': 'application/manifest+json' } },
  );
}
