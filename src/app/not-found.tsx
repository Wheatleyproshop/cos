import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="authwrap">
      <div className="authcard">
        <div className="eyebrow">NOT FOUND</div>
        <h2 style={{ marginTop: 8 }}>We couldn’t find that page.</h2>
        <p>It may have been archived, or the link may be incomplete.</p>
        <Link href="/" className="btn primary">
          Back to COS
        </Link>
      </div>
    </div>
  );
}
