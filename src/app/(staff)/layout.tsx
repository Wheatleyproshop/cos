import type { Metadata } from 'next';
import { Sidebar } from '@/components/chrome';
import { ServiceWorker } from '@/components/notifications';
import { requireStaff, ROLE_LABELS } from '@/lib/auth';
import { logoutAction } from './actions';

export const metadata: Metadata = {
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icons/icon.svg?v=2', apple: '/icons/apple-180.png?v=2' },
  appleWebApp: { capable: true, title: 'COS', statusBarStyle: 'black-translucent' },
};

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const staff = await requireStaff();
  return (
    <>
      <a href="#content" className="skip">
        Skip to content
      </a>
      <Sidebar storeName={staff.org.storeName} userName={staff.name} roleLabel={ROLE_LABELS[staff.role]} signOut={logoutAction} sharedLoginName={staff.sharedLoginName} />
      <main id="content">{children}</main>
      <ServiceWorker />
    </>
  );
}
