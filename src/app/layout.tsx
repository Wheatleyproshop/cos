import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'COS Golf — Customer Order System', template: '%s · COS Golf' },
  description: 'Customer order management for golf professional shops.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0e1522' };

export default function RootLayout({ children, modal }: { children: React.ReactNode; modal: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body>
        {children}
        {modal}
      </body>
    </html>
  );
}
