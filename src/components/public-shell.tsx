import type { ReactNode } from 'react';
import type { CSSProperties } from 'react';
import type { Organisation } from '@/db/schema';
import { resolveBrand } from '@/lib/branding';

/** Customer-facing frame: the retailer's identity only — no COS branding. */
export function PublicShell({ org, children, wide }: { org: Organisation; children: ReactNode; wide?: boolean }) {
  const b = resolveBrand(org);
  const contact = [org.collectionLocation, org.storePhone, org.openingHours].filter(Boolean);
  const mark = b.logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={b.logoUrl} alt={org.storeName} style={{ height: 72, width: 'auto', maxWidth: 300, display: 'inline-block', verticalAlign: 'middle' }} />
  ) : (
    org.storeName.toUpperCase()
  );
  const vars = { '--green': b.accent, '--brand-heading': b.headingFont, '--brand-radius': b.radius } as CSSProperties;
  return (
    <div className={`public branded${wide ? ' wide' : ''}`} style={vars}>
      {b.fontsHref ? <link rel="stylesheet" href={b.fontsHref} precedence="default" /> : null}
      <header className="public-head" style={{ background: b.headerBg, color: b.headerText, fontFamily: b.headingFont }}>
        {b.websiteUrl ? <a href={b.websiteUrl} style={{ color: 'inherit', textDecoration: 'none' }}>{mark}</a> : mark}
      </header>
      <div className="public-bar" style={{ background: b.accent, color: b.accentText }} />
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
