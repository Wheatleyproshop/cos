'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/** Reloads the page's data from the server. Essential when COS runs as an installed app (no browser reload button). */
export function RefreshButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="bell"
      title="Refresh"
      aria-label={pending ? 'Refreshing' : done ? 'Refreshed' : 'Refresh'}
      disabled={pending}
      onClick={() =>
        start(() => {
          router.refresh();
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" className={pending ? 'spin' : undefined}>
        <path
          fill="currentColor"
          d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.74 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35Z"
        />
      </svg>
    </button>
  );
}
