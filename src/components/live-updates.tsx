'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useTransition } from 'react';

/**
 * Keeps a server-rendered page current: re-fetches its data every `seconds` while the tab is
 * visible, and straight away when someone comes back to a tab that has gone stale. Shows when the
 * figures were last updated (`updatedAt` is formatted on the server, so it changes on each refresh).
 */
export function LiveUpdates({ updatedAt, seconds = 60 }: { updatedAt: string; seconds?: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const last = useRef(Date.now());

  useEffect(() => {
    last.current = Date.now();
  }, [updatedAt]);

  useEffect(() => {
    const refresh = () => {
      last.current = Date.now();
      start(() => router.refresh());
    };
    const tick = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, seconds * 1000);
    const onShow = () => {
      if (document.visibilityState === 'visible' && Date.now() - last.current > 30_000) refresh();
    };
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('focus', onShow);
    return () => {
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onShow);
      window.removeEventListener('focus', onShow);
    };
  }, [router, seconds]);

  return (
    <span className={`live${pending ? ' live--busy' : ''}`} role="status" aria-live="polite" title={`Updates automatically every ${seconds} seconds`}>
      <i aria-hidden="true" />
      Live · {pending ? 'updating…' : `updated ${updatedAt}`}
    </span>
  );
}
