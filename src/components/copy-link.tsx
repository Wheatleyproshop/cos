'use client';

import { useState } from 'react';

/** A read-only link with Copy and Open buttons. */
export function CopyLink({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="design-link">
      <input readOnly value={url} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
      <button
        type="button"
        className="btn small"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            /* the box is selectable as a fallback */
          }
        }}
      >
        {copied ? 'Copied ✓' : 'Copy link'}
      </button>
      <a className="btn small" href={url} target="_blank" rel="noopener">
        Open ↗
      </a>
    </div>
  );
}
