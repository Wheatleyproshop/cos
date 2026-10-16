'use client';

import { useRouter } from 'next/navigation';

export function CancelButton() {
  const router = useRouter();
  return (
    <button type="button" className="btn" onClick={() => router.back()}>
      Cancel
    </button>
  );
}
