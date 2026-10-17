import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // PGlite ships WASM + data files that must be loaded from node_modules at runtime.
  serverExternalPackages: ['@electric-sql/pglite'],
  experimental: { serverActions: { bodySizeLimit: '5mb' } },
  poweredByHeader: false,
  // The icon renderer reads Inter from node_modules at runtime.
  outputFileTracingIncludes: { '/icons/[name]': ['./node_modules/@fontsource/inter/files/inter-latin-{600,800}-normal.woff'] },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
      {
        // Customer token links must never leak via referrer or be indexed.
        source: '/(q|t|w)/:token*',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
};

export default nextConfig;
