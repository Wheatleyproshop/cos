'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type WakeLock = { release: () => Promise<void> };

/**
 * TV mode controls: a ticking clock, a full-screen button, and a screen wake lock so the TV or
 * tablet doesn't go to sleep while the dashboard is showing. Controls fade out when the mouse is idle.
 */
export function TvControls({ tz }: { tz: string }) {
  const [now, setNow] = useState<Date | null>(null);
  const [full, setFull] = useState(false);
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onChange = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Keep the screen awake (re-acquired when the tab comes back, as browsers drop it when hidden).
  useEffect(() => {
    let lock: WakeLock | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<WakeLock> } };
    const get = async () => {
      try {
        if (nav.wakeLock && document.visibilityState === 'visible') lock = await nav.wakeLock.request('screen');
      } catch {
        /* not supported or not allowed: the screen's own sleep settings apply */
      }
    };
    get();
    document.addEventListener('visibilitychange', get);
    return () => {
      document.removeEventListener('visibilitychange', get);
      lock?.release().catch(() => {});
    };
  }, []);

  // Hide the buttons and cursor after a few seconds without the mouse moving.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const wake = () => {
      setIdle(false);
      clearTimeout(t);
      t = setTimeout(() => setIdle(true), 4000);
    };
    wake();
    window.addEventListener('mousemove', wake);
    window.addEventListener('keydown', wake);
    window.addEventListener('touchstart', wake);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousemove', wake);
      window.removeEventListener('keydown', wake);
      window.removeEventListener('touchstart', wake);
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('tv-idle', idle);
  }, [idle]);

  // Scale the whole board to fill the screen height exactly, on any TV from 720p to 4K. Zooming also
  // changes the layout width (and so the height), so it settles in a few steps. Re-checked on resize
  // and every few seconds, as the figures (and so the height) change when the board refreshes.
  useEffect(() => {
    const tv = document.querySelector<HTMLElement>('.tv');
    if (!tv) return;
    const fit = () => {
      const target = window.innerHeight;
      let z = Number(tv.style.zoom) || 1;
      for (let i = 0; i < 6; i++) {
        const h = tv.getBoundingClientRect().height;
        if (Math.abs(h - target) < 3 && h <= target) break;
        z = Math.min(3, Math.max(0.4, Math.floor(z * (target / h) * 0.998 * 1000) / 1000));
        tv.style.zoom = String(z);
      }
      while (tv.getBoundingClientRect().height > target && z > 0.4) {
        z = Math.floor(z * 0.99 * 1000) / 1000;
        tv.style.zoom = String(z);
      }
    };
    fit();
    const t = setInterval(fit, 5000);
    window.addEventListener('resize', fit);
    document.addEventListener('fullscreenchange', fit);
    return () => {
      clearInterval(t);
      window.removeEventListener('resize', fit);
      document.removeEventListener('fullscreenchange', fit);
    };
  }, []);

  const toggle = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  };

  return (
    <div className="tv-clock-wrap">
      <div className="tv-clock" suppressHydrationWarning>
        <b>{now ? now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }) : '--:--'}</b>
        <span>{now ? now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz }) : ''}</span>
      </div>
      <div className="tv-buttons">
        <button type="button" className="tv-btn" onClick={toggle}>
          {full ? 'Exit full screen' : '⛶ Full screen'}
        </button>
        <Link href="/" className="tv-btn">
          ✕ Close
        </Link>
      </div>
    </div>
  );
}
