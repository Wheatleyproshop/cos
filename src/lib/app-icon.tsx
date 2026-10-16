/** The COS Golf app icon: dark navy tile, white COS wordmark, blue dot, letter-spaced GOLF. */
export const ICON_DOT = '#1f7bff';

const FONT = "Inter,-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif";

export function iconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2c3648"/><stop offset=".45" stop-color="#121a28"/><stop offset="1" stop-color="#0b0f18"/></linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".10"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <path d="M0 112A112 112 0 0 1 112 0h288L0 400z" fill="url(#sheen)"/>
  <text x="243" y="285" text-anchor="middle" font-family="${FONT}" font-size="176" font-weight="700" letter-spacing="-6" fill="#f4f6f9">COS</text>
  <circle cx="420" cy="270" r="19" fill="${ICON_DOT}"/>
  <text x="256" y="356" text-anchor="middle" font-family="${FONT}" font-size="38" font-weight="600" letter-spacing="22" fill="#c9ced6">GOLF</text>
</svg>`;
}

/** JSX version for next/og ImageResponse (PNG icons). `pad` shrinks content for maskable icons. */
export function IconTile({ size, pad = 0, rounded = true }: { size: number; pad?: number; rounded?: boolean }) {
  const s = size * (1 - pad * 2);
  return (
    <div
      style={{
        width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
        background: 'linear-gradient(135deg, #2c3648 0%, #121a28 45%, #0b0f18 100%)', borderRadius: rounded ? size * 0.22 : 0,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', color: '#f4f6f9', fontFamily: 'Inter', fontWeight: 800, fontSize: s * 0.34, letterSpacing: -s * 0.012, lineHeight: 1 }}>
          COS
          <div style={{ width: s * 0.075, height: s * 0.075, borderRadius: 999, background: ICON_DOT, marginLeft: s * 0.012, marginBottom: s * 0.03 }} />
        </div>
        {s >= 120 ? (
          <div style={{ color: '#c9ced6', fontFamily: 'Inter', fontWeight: 600, fontSize: s * 0.075, letterSpacing: s * 0.045, marginTop: s * 0.05, paddingLeft: s * 0.045 }}>
            GOLF
          </div>
        ) : null}
      </div>
    </div>
  );
}
