import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'COS Golf — Customer Order System', template: '%s · COS Golf' },
  description: 'Customer order management for golf professional shops.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#ecebe6' };

export default function RootLayout({ children, modal }: { children: React.ReactNode; modal: React.ReactNode }) {
  return (
    <html lang="en-GB" className={inter.variable}>
      <body>
        {children}
        {modal}
      </body>
    </html>
  );
}
