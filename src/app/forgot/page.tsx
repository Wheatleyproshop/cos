import type { Metadata } from 'next';
import { ForgotForm } from './forgot-form';

export const metadata: Metadata = { title: 'Forgotten password' };

export default function ForgotPage() {
  return (
    <main className="authwrap" style={{ margin: 0, maxWidth: 'none' }}>
      <div className="authcard">
        <div className="brand">
          COS<span>.</span>
        </div>
        <div className="eyebrow" style={{ marginTop: 4 }}>
          FORGOTTEN PASSWORD
        </div>
        <ForgotForm />
      </div>
    </main>
  );
}
