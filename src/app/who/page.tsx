import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getStaff, listPickableMembers, ROLE_LABELS } from '@/lib/auth';
import { logoutAction } from '../(staff)/actions';
import { pickMemberAction } from './actions';

export const metadata: Metadata = {
  title: 'Who’s working?',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icons/icon.svg?v=2', apple: '/icons/apple-180.png?v=2' },
};

/** Shared counter login: each person picks their name so orders and changes are attributed to them. */
export default async function WhoPage() {
  const staff = await getStaff();
  if (!staff) redirect('/login');
  if (!staff.sharedLoginName) redirect('/');
  const members = await listPickableMembers(staff.organisationId);
  return (
    <main className="authwrap" style={{ margin: 0, maxWidth: 'none' }}>
      <div className="authcard" style={{ width: 'min(520px, 100%)' }}>
        <div className="brand">
          COS<span>.</span>
        </div>
        <div className="eyebrow" style={{ marginTop: 4 }}>
          {staff.org.storeName.toUpperCase()} · {staff.sharedLoginName.toUpperCase()}
        </div>
        <h2 style={{ marginTop: 18 }}>Who’s working?</h2>
        <p style={{ marginTop: 0 }}>Pick your name. Orders you take and changes you make are recorded against you.</p>
        <div className="whogrid">
          {members.map((m) => (
            <form key={m.id} action={pickMemberAction.bind(null, m.id)}>
              <button className="whobtn" type="submit">
                <span className="avatar">{m.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase()}</span>
                <span>
                  <b>{m.name}</b>
                  <small>{ROLE_LABELS[m.role]}</small>
                </span>
              </button>
            </form>
          ))}
        </div>
        {members.length === 0 ? <div className="notice warn">No team members yet. An owner/admin can add them in Store settings → Team.</div> : null}
        <form action={logoutAction} style={{ marginTop: 18 }}>
          <button className="linkbtn" type="submit">
            Sign out of {staff.sharedLoginName}
          </button>
        </form>
      </div>
    </main>
  );
}
