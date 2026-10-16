/** The COS app icon: dark-green tile, COS wordmark with a green dot. Used for PWA/Dock/Home Screen. */
export const ICON_BG = '#173326';
export const ICON_DOT = '#4caf50';

export function iconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#21463a"/><stop offset="1" stop-color="#132a20"/></linearGradient></defs>
  <rect width="512" height="512" rx="112" fill="url(#g)"/>
  <text x="236" y="290" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif" font-size="168" font-weight="700" letter-spacing="-8" fill="#fff">COS</text>
  <circle cx="404" cy="280" r="17" fill="${ICON_DOT}"/>
  <text x="256" y="356" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif" font-size="30" fill="#c9d8cd">Customer Order System</text>
</svg>`;
}

/** JSX version for next/og ImageResponse (PNG icons). `pad` shrinks content for maskable icons. */
export function IconTile({ size, pad = 0, rounded = true }: { size: number; pad?: number; rounded?: boolean }) {
  const s = size * (1 - pad * 2);
  return (
    <div
      style={{
        width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'linear-gradient(180deg, #21463a 0%, #132a20 100%)', borderRadius: rounded ? size * 0.22 : 0,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', color: '#fff', fontSize: s * 0.33, fontWeight: 700, letterSpacing: -s * 0.015, lineHeight: 1 }}>
          COS
          <div style={{ width: s * 0.066, height: s * 0.066, borderRadius: 999, background: ICON_DOT, marginLeft: s * 0.012, marginBottom: s * 0.02 }} />
        </div>
        {s >= 120 ? <div style={{ color: '#c9d8cd', fontSize: s * 0.058, marginTop: s * 0.04 }}>Customer Order System</div> : null}
      </div>
    </div>
  );
}
