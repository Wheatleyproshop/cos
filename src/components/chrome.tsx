'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';

const NAV = [
  { href: '/', icon: '◫', label: 'Overview' },
  { href: '/orders', icon: '▤', label: 'All orders' },
  { href: '/quotes', icon: '◇', label: 'Quotes' },
  { href: '/fitting', icon: '✎', label: 'Custom Fitting' },
  { href: '/ball-printing', icon: '◎', label: 'Ball Printing' },
  { href: '/cresting', icon: '✂', label: 'Clothing Cresting' },
  { href: '/workshop', icon: '⚒', label: 'Workshop' },
  { href: '/prebook', icon: '◷', label: 'Pre-book' },
  { href: '/customers', icon: '☺', label: 'Customers' },
  { href: '/products', icon: '▣', label: 'Products' },
  { href: '/accounts', icon: '☏', label: 'Accounts' },
  { href: '/emails', icon: '✉', label: 'Email previews' },
  { href: '/settings', icon: '⚙', label: 'Store settings' },
];

export function Sidebar({
  storeName, userName, roleLabel, signOut, sharedLoginName,
}: { storeName: string; userName: string; roleLabel: string; signOut: () => Promise<void>; sharedLoginName?: string | null }) {
  const path = usePathname();
  const isActive = (href: string) => (href === '/' ? path === '/' : path === href || path.startsWith(href + '/'));
  // Phones and small tablets: the sidebar is a drawer opened from the ☰ button.
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 950px)');
    const update = () => {
      setCompact(mq.matches);
      if (!mq.matches) setOpen(false);
    };
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // Close after navigating.
  useEffect(() => setOpen(false), [path]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open]);

  const hidden = compact && !open;
  return (
    <>
      <header className="mobilebar">
        <button
          ref={menuButton}
          type="button"
          className="menubtn"
          aria-label="Open menu"
          aria-expanded={open}
          aria-controls="sidenav"
          onClick={() => setOpen(true)}
        >
          <span aria-hidden="true" />
          <span aria-hidden="true" />
          <span aria-hidden="true" />
        </button>
        <Link href="/" className="mobilelogo" aria-label="COS Golf overview">
          COS<span className="logo-dot" aria-hidden="true" />
        </Link>
        <span className="mobilebar-store">{storeName}</span>
      </header>
      {open ? <div className="navscrim" onClick={() => setOpen(false)} aria-hidden="true" /> : null}
      <aside id="sidenav" aria-label="Main navigation" className={open ? 'open' : ''} inert={hidden || undefined} aria-hidden={hidden || undefined}>
        {compact ? (
          <button type="button" className="navclose" aria-label="Close menu" onClick={() => setOpen(false)}>
            ✕
          </button>
        ) : null}
        <Link href="/" className="logo" aria-label="COS Golf overview">
          <span className="logo-mark">
            COS<span className="logo-dot" aria-hidden="true" />
          </span>
          <span className="logo-sub">GOLF</span>
        </Link>
        <nav>
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={`nav${isActive(n.href) ? ' active' : ''}`} aria-current={isActive(n.href) ? 'page' : undefined} title={n.label}>
              <span className="icon" aria-hidden="true">
                {n.icon}
              </span>
              <span className="navtext">{n.label}</span>
            </Link>
          ))}
        </nav>
        <div className="asidebottom">
          <div className="org">{storeName.toUpperCase()}</div>
          <div className="who">
            <span className="avatar" aria-hidden="true">
              {userName.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase()}
            </span>
            <span>
              <b>{userName}</b>
              <br />
              {roleLabel}
            </span>
          </div>
          {sharedLoginName ? (
            <div className="working">
              {sharedLoginName} login · <Link href="/who">Change person</Link>
            </div>
          ) : null}
          <form action={signOut}>
            <button className="signout" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </aside>
    </>
  );
}

/** Intercepted-route modal. Closes on Esc, backdrop click or the × button. */
export function Modal({ children, label }: { children: ReactNode; label: string }) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && router.back();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      prev?.focus?.();
    };
  }, [router]);
  return (
    <div className="modalbg" onMouseDown={(e) => e.target === e.currentTarget && router.back()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={ref}>
        {children}
      </div>
    </div>
  );
}

/** × button: closes the modal, or returns to a list when the detail is a full page. */
export function CloseButton({ fallback, inModal }: { fallback: string; inModal: boolean }) {
  const router = useRouter();
  return inModal ? (
    <button type="button" className="x" aria-label="Close" onClick={() => router.back()}>
      ×
    </button>
  ) : (
    <Link href={fallback} className="x" aria-label="Close">
      ×
    </Link>
  );
}

/** Debounced search box that keeps the query in the URL (shareable, back-button friendly). */
export function SearchBox({ placeholder }: { placeholder: string }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [value, setValue] = useState(params.get('q') ?? '');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <>
      <label htmlFor="search" className="sr-only">
        Search
      </label>
      <input
        id="search"
        className="search"
        type="search"
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          setValue(v);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            const next = new URLSearchParams(params.toString());
            if (v.trim()) next.set('q', v.trim());
            else next.delete('q');
            router.replace(`${path}${next.size ? `?${next}` : ''}`, { scroll: false });
          }, 250);
        }}
      />
    </>
  );
}

/** Whole table row is clickable; the title link remains the accessible target. */
export function RowLink({ href, children }: { href: string; children: ReactNode }) {
  const router = useRouter();
  return (
    <tr
      className="rowlink"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a,button')) return;
        router.push(href, { scroll: false });
      }}
    >
      {children}
    </tr>
  );
}
