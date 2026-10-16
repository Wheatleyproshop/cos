'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NotificationItem } from '@/lib/services/notifications';

const POLL_MS = 20_000;

export function ServiceWorker() {
  useEffect(() => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, []);
  return null;
}

async function systemNotify(n: NotificationItem) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const opts = { body: n.body, icon: '/icons/icon-192.png?v=2', tag: n.id, data: { url: n.href } };
  const reg = await navigator.serviceWorker?.getRegistration();
  if (reg) await reg.showNotification(n.title, opts);
  else new Notification(n.title, opts);
}

/** Bell with live feed: polls the ledger and raises Mac/iPhone system notifications when allowed. */
export function NotificationBell() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>('default');
  const known = useRef<Set<string> | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { items: NotificationItem[]; unread: number };
      if (known.current) {
        for (const n of data.items) if (n.unread && !known.current.has(n.id)) void systemNotify(n);
      }
      known.current = new Set(data.items.map((n) => n.id));
      setItems(data.items);
      setUnread(data.unread);
    } catch {
      /* offline — try again next tick */
    }
  }, []);

  useEffect(() => {
    setPerm(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
    void load();
    const t = setInterval(() => document.visibilityState !== 'hidden' || perm === 'granted' ? load() : undefined, POLL_MS);
    const onDoc = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => {
      clearInterval(t);
      document.removeEventListener('mousedown', onDoc);
    };
  }, [load, perm]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && unread) {
      await fetch('/api/notifications', { method: 'POST' });
      setUnread(0);
    }
  };

  return (
    <div className="bellwrap" ref={box}>
      <button type="button" className="bell" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} onClick={toggle}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z" />
        </svg>
        {unread ? <span className="dot">{unread > 9 ? '9+' : unread}</span> : null}
      </button>
      {open ? (
        <div className="bellmenu" role="dialog" aria-label="Notifications">
          <div className="panel-head">
            <b>Notifications</b>
            {perm === 'default' ? (
              <button type="button" className="linkbtn" onClick={async () => setPerm(await Notification.requestPermission())}>
                Turn on desktop alerts
              </button>
            ) : perm === 'granted' ? (
              <span className="muted" style={{ marginTop: 0 }}>Desktop alerts on</span>
            ) : null}
          </div>
          {items.length ? (
            <ul>
              {items.map((n) => (
                <li key={n.id} className={n.unread ? 'unread' : ''}>
                  <Link href={n.href} onClick={() => setOpen(false)} scroll={false}>
                    <b>{n.title}</b>
                    <span>{n.body}</span>
                    <small>{new Date(n.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Nothing yet. New orders, quote approvals and delivery problems appear here.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
