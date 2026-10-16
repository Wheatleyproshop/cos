'use client';

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div style={{ padding: 40 }}>
      <div className="panel" role="alert">
        <h2>Something went wrong loading this page.</h2>
        <p>Nothing has been changed. Try again, and if it keeps happening let your COS admin know.</p>
        <button className="btn primary" onClick={reset}>
          Try again
        </button>
      </div>
    </div>
  );
}
