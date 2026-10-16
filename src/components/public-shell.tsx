import type { ReactNode } from 'react';
import type { Organisation } from '@/db/schema';

/** Customer-facing frame: the retailer's identity only — no COS branding. */
export function PublicShell({ org, children }: { org: Organisation; children: ReactNode }) {
  const color = /^#[0-9a-f]{6}$/i.test(org.brandColor) ? org.brandColor : '#193b2c';
  const contact = [org.collectionLocation, org.storePhone, org.openingHours].filter(Boolean);
  return (
    <div className="public">
      <header className="public-head" style={{ background: color }}>
        {org.storeName.toUpperCase()}
      </header>
      <div className="public-body">{children}</div>
      <footer className="footnote">
        {org.storeName}
        {contact.map((c) => (
          <span key={c}> · {c}</span>
        ))}
        <br />
        Questions? Email <a href={`mailto:${org.replyToEmail}`}>{org.replyToEmail}</a>
      </footer>
    </div>
  );
}

export function InvalidLink({ title, body }: { title: string; body: string }) {
  return (
    <div className="public">
      <div className="public-body" style={{ borderTop: '1px solid #e4e8e2', borderRadius: 16 }}>
        <h1 style={{ fontSize: 24 }}>{title}</h1>
        <p>{body}</p>
      </div>
    </div>
  );
}
