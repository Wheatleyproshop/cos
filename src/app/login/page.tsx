import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getStaff } from '@/lib/auth';
import { LoginForm } from './login-form';

export const metadata: Metadata = {
  title: 'Sign in',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icons/icon.svg?v=2', apple: '/icons/apple-180.png?v=2' },
  appleWebApp: { capable: true, title: 'COS', statusBarStyle: 'black-translucent' },
};

export default async function LoginPage() {
  if (await getStaff()) redirect('/');
  const demo = process.env.DEMO_MODE === 'true' && process.env.NODE_ENV !== 'production';
  return (
    <main className="authwrap" style={{ margin: 0, maxWidth: 'none' }}>
      <div className="authcard">
        <div className="brand">
          COS<span>.</span>
        </div>
        <div className="eyebrow" style={{ marginTop: 4 }}>
          GOLF · CUSTOMER ORDER SYSTEM
        </div>
        <LoginForm />
        {demo ? (
          <div className="notice" style={{ marginBottom: 0 }}>
            <b>Demo workspace</b>
            aaron@desirablegolf.test (admin), chris@… (manager) or will@… (staff). Password: cos-demo-2026
          </div>
        ) : null}
      </div>
    </main>
  );
}
