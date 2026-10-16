/** Neutral club silhouettes (no manufacturer artwork). Upload real imagery via the catalogue later. */
export function ClubIcon({ kind, size = 72 }: { kind: string; size?: number }) {
  const head: Record<string, React.ReactNode> = {
    driver: <path d="M18 52c-6-14 4-30 24-32 14-1 24 8 22 20-1 10-12 17-28 17-9 0-15-1-18-5z" />,
    fairway: <path d="M20 54c-4-10 4-22 20-23 12-1 20 6 19 15-1 8-10 13-23 13-7 0-13-1-16-5z" />,
    hybrid: <path d="M20 55c-3-9 3-19 17-21 12-2 20 4 20 12 0 8-9 13-21 13-7 0-13-1-16-4z" />,
    irons: <path d="M18 58l6-22c1-4 5-6 9-5l24 7c3 1 5 4 4 7l-4 13c-1 3-4 4-7 4H22c-3 0-5-2-4-4z" />,
    wedge: <path d="M18 58l9-26c1-3 4-5 8-4l20 6c3 1 5 4 4 7l-6 17c-1 3-4 4-7 4H22c-3 0-5-2-4-4z" />,
    putter: <path d="M14 50h40c4 0 6 3 6 6v2c0 2-2 4-4 4H14c-3 0-4-2-4-4v-4c0-2 2-4 4-4z" />,
  };
  const shaftTop: Record<string, string> = { driver: 'M54 22L66 4', fairway: 'M52 33L66 4', hybrid: 'M50 36L66 4', irons: 'M48 37L64 4', wedge: 'M48 34L64 4', putter: 'M40 50L60 4' };
  return (
    <svg width={size} height={size} viewBox="0 0 72 72" aria-hidden="true">
      <path d={shaftTop[kind] ?? shaftTop.driver} stroke="#5b6560" strokeWidth="2.5" strokeLinecap="round" fill="none" />
      <g fill="#20251f">{head[kind] ?? head.driver}</g>
      <path d="M26 46c6 3 18 3 26-1" stroke="#ffffff33" strokeWidth="2" fill="none" />
    </svg>
  );
}

export function PartIcon({ kind, size = 56 }: { kind: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 56 56" aria-hidden="true">
      {kind === 'ball' ? (
        <>
          <circle cx="28" cy="28" r="18" fill="#fff" stroke="#c9d0c7" strokeWidth="2" />
          {[[22, 22], [30, 20], [36, 27], [24, 31], [32, 34], [20, 27]].map(([x, y]) => (
            <circle key={`${x}${y}`} cx={x} cy={y} r="1.6" fill="#c9d0c7" />
          ))}
        </>
      ) : kind === 'grip' ? (
        <path d="M14 46L40 10" stroke="#20251f" strokeWidth="10" strokeLinecap="round" />
      ) : (
        <path d="M10 48L46 8" stroke="#3b4a42" strokeWidth="3.5" strokeLinecap="round" />
      )}
    </svg>
  );
}
