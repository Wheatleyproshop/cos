import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { cookies } from 'next/headers';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'COS Golf — Customer Order System', template: '%s · COS Golf' },
  description: 'Customer order management for golf professional shops.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#ecebe6' };

export default async function RootLayout({ children, modal }: { children: React.ReactNode; modal: React.ReactNode }) {
  // Staff's light/dark choice (dark styles only apply on staff pages; customer pages stay light).
  const theme = (await cookies()).get('cos-theme')?.value === 'dark' ? 'dark' : 'light';
  return (
    <html lang="en-GB" className={inter.variable} data-theme={theme}>
      <body>
        {children}
        {modal}
      </body>
    </html>
  );
}
