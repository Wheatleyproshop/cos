import type { Metadata } from 'next';
import { ActionButton } from '@/components/forms';
import { AutomationsForm, NewUserForm, PasswordForm, StoreForm, TeamMemberControls, ThresholdsForm } from '@/components/misc-forms';
import { PageHeader } from '@/components/views';
import { fromHeader } from '@/lib/email/sender';
import { hasRole, requireStaff, ROLE_LABELS } from '@/lib/auth';
import { bytes, stamp } from '@/lib/format';
import { hasFeature, PLANS } from '@/lib/plans';
import { getSettingsData } from '@/lib/queries';
import {
  automationsAction,
  backupNowAction,
  changePasswordAction,
  recheckSenderAction,
  createUserAction,
  storeSettingsAction,
  thresholdsAction,
  updateUserAction,
} from '../actions';

export const metadata: Metadata = { title: 'Store settings' };

export default async function SettingsPage() {
  const staff = await requireStaff();
  const org = staff.org;
  const admin = hasRole(staff, 'admin');
  const { team, runs } = await getSettingsData(org);
  const tz = org.timezone;
  const plan = PLANS[org.plan];

  return (
    <>
      <PageHeader staff={staff} title="Store settings." sub="Make COS feel like your own store." actions={<span />} />
      {!admin ? <div className="notice warn">Only an owner/admin can change store settings. You can still change your own password below.</div> : null}

      <section className="panel">
        <h2>Store identity</h2>
        <p>Customise the brand your customers see on emails, quote approvals and tracking pages.</p>
        {admin && org.senderEmail && !org.senderVerifiedAt ? (
          <div className="notice warn" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <span>
              <b>{org.senderEmail} isn’t verified yet</b>
              Emails go from the COS address until the domain’s DNS records are verified.
            </span>
            <ActionButton action={recheckSenderAction} className="btn small">
              Check again
            </ActionButton>
          </div>
        ) : null}
        <StoreForm
          action={storeSettingsAction}
          disabled={!admin}
          values={{
            storeName: org.storeName, replyToEmail: org.replyToEmail, senderEmail: org.senderEmail,
            senderHint: `Customers currently receive emails from “${fromHeader(org)}”.${org.senderEmail && !org.senderVerifiedAt ? ' Your own address will be used once its domain is verified.' : ''}`, collectionLocation: org.collectionLocation, storePhone: org.storePhone,
            openingHours: org.openingHours, brandColor: org.brandColor, quoteTerms: org.quoteTerms,
          }}
        />
      </section>

      <div className="split" style={{ marginTop: 18 }}>
        <section className="panel">
          <h2>Customer email automations</h2>
          <p>Turned-off automations are recorded on each order as “not sent”, so the audit trail stays complete.</p>
          <AutomationsForm action={automationsAction} enabled={org.emailAutomations} disabled={!admin} />
        </section>
        <section className="panel">
          <h2>Attention rules</h2>
          <p>When COS should flag an order or quote on the Overview.</p>
          <ThresholdsForm
            action={thresholdsAction}
            disabled={!admin}
            values={{ readyUncollectedDays: org.readyUncollectedDays, quoteFollowupDays: org.quoteFollowupDays, missingSupplierRefDays: org.missingSupplierRefDays }}
          />
        </section>
      </div>

      <section className="panel">
        <h2>Team</h2>
        <p>
          Everyone signs in as themselves, so every order, change and payment is attributed. Accounts are deactivated, never deleted. {plan.label} plan:{' '}
          {team.filter((t) => t.active).length} of {plan.staffLimit} active accounts.
        </p>
        <div className="tablewrap">
          <table className="compact">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Last sign-in</th>
                <th>{admin ? 'Manage' : 'Status'}</th>
              </tr>
            </thead>
            <tbody>
              {team.map((u) => (
                <tr key={u.id} style={u.active ? undefined : { opacity: 0.55 }}>
                  <td>
                    <b>{u.name}</b>
                    <div className="muted">{u.email}</div>
                  </td>
                  <td>{ROLE_LABELS[u.role]}</td>
                  <td>{u.lastLoginAt ? stamp(u.lastLoginAt, tz) : 'Never'}</td>
                  <td>
                    {admin ? (
                      <TeamMemberControls role={u.role} active={u.active} isSelf={u.id === staff.id} update={updateUserAction.bind(null, u.id)} />
                    ) : u.active ? (
                      'Active'
                    ) : (
                      'Deactivated'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {admin ? (
          <details className="section">
            <summary>Add a team member</summary>
            <NewUserForm action={createUserAction} />
          </details>
        ) : null}
      </section>

      <section className="panel">
        <h2>Backups & export</h2>
        <div className="settingsrow">
          <div>
            <b>Download a full export</b>
            <div className="muted">Every customer, order, quote, payment, email and audit event as JSON — or orders as CSV for spreadsheets.</div>
          </div>
          {admin ? (
            <span style={{ display: 'flex', gap: 8 }}>
              <a className="btn small" href="/api/export?format=csv">
                Orders CSV
              </a>
              <a className="btn small" href="/api/export">
                Full JSON
              </a>
            </span>
          ) : (
            <span className="badge">Admin only</span>
          )}
        </div>
        <div className="settingsrow">
          <div>
            <b>COS Cloud nightly backup</b>
            <div className="muted">Encrypted, private snapshot stored by COS every night.</div>
          </div>
          {hasFeature(org, 'backup.cos_hosted') ? (
            admin ? (
              <ActionButton action={backupNowAction.bind(null, 'cos_hosted')} className="btn small">
                Back up now
              </ActionButton>
            ) : (
              <span className="badge ready">Enabled</span>
            )
          ) : (
            <span className="badge">Upgrade to enable</span>
          )}
        </div>
        {(['google_drive', 'dropbox'] as const).map((p) => (
          <div className="settingsrow" key={p}>
            <div>
              <b>{p === 'google_drive' ? 'Google Drive export' : 'Dropbox export'}</b>
              <div className="muted">Nightly copy into your own {p === 'google_drive' ? 'Google Drive' : 'Dropbox'} folder.</div>
            </div>
            <span className="badge">{hasFeature(org, `backup.${p}`) ? 'Connection coming soon' : 'Pro plan'}</span>
          </div>
        ))}
        {runs.length ? (
          <>
            <h3>Recent backups</h3>
            <ul className="attention">
              {runs.map((r) => (
                <li key={r.id}>
                  <span>
                    {r.provider === 'cos_hosted' ? 'COS Cloud' : r.provider} · {stamp(r.startedAt, tz)}
                    {r.error ? <div className="muted">{r.error}</div> : null}
                  </span>
                  <span>
                    <span className={`badge${r.status === 'succeeded' ? ' ready' : r.status === 'failed' ? ' failed' : ''}`}>{r.status}</span>
                    {r.sizeBytes ? <span className="muted"> {bytes(r.sizeBytes)}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <div className="split" style={{ marginTop: 18 }}>
        <section className="panel">
          <h2>Subscription</h2>
          <dl className="kv">
            <dt>Plan</dt>
            <dd>
              {plan.label}
              {org.plan === 'trial' && org.trialEndsAt ? ` · ends ${stamp(org.trialEndsAt, tz).split(' · ')[0]}` : ''}
            </dd>
            <dt>Staff accounts</dt>
            <dd>{plan.staffLimit}</dd>
            <dt>Emails / month</dt>
            <dd>{plan.monthlyEmails.toLocaleString('en-GB')}</dd>
            <dt>COS Configure</dt>
            <dd>{hasFeature(org, 'configure') ? 'Included' : 'Pro plan (coming soon)'}</dd>
          </dl>
        </section>
        <section className="panel">
          <h2>Your account</h2>
          <p>
            Signed in as <b>{staff.name}</b> ({staff.email}) · {ROLE_LABELS[staff.role]}
          </p>
          <PasswordForm action={changePasswordAction} />
        </section>
      </div>
    </>
  );
}
