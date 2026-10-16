/**
 * Per-retailer customer-facing branding (emails, quote approval and tracking pages).
 * Stored on organisations.brand_theme; missing values fall back to tasteful defaults.
 */
export type HeadingFont = 'barlow' | 'inter' | 'georgia' | 'system';

export type BrandTheme = {
  logoUrl?: string;
  websiteUrl?: string;
  headerTextColor?: string;
  accentColor?: string;
  headingFont?: HeadingFont;
  squareButtons?: boolean;
};

export type ResolvedBrand = {
  headerBg: string;
  headerText: string;
  accent: string;
  accentText: string;
  logoUrl: string;
  websiteUrl: string;
  headingFont: string;
  bodyFont: string;
  radius: string;
  fontsHref: string | null;
};

const HEX = /^#[0-9a-f]{6}$/i;

export const HEADING_FONTS: Record<HeadingFont, { label: string; stack: string; google?: string }> = {
  barlow: { label: 'Barlow (modern sans)', stack: "Barlow,'Helvetica Neue',Helvetica,Arial,sans-serif", google: 'Barlow:wght@500;600' },
  inter: { label: 'Inter (clean sans)', stack: "Inter,'Helvetica Neue',Helvetica,Arial,sans-serif", google: 'Inter:wght@600;700' },
  georgia: { label: 'Georgia (classic serif)', stack: "Georgia,'Times New Roman',serif" },
  system: { label: 'System default', stack: "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" },
};

const BODY_STACK = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

/** Readable text colour for a background. */
export function contrastText(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#090a11' : '#ffffff';
}

const httpsUrl = (u?: string) => (u && /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : '');

export function resolveBrand(org: { brandColor: string; brandTheme?: BrandTheme | null }): ResolvedBrand {
  const t = org.brandTheme ?? {};
  const headerBg = HEX.test(org.brandColor) ? org.brandColor : '#193b2c';
  const accent = t.accentColor && HEX.test(t.accentColor) ? t.accentColor : headerBg;
  const font = HEADING_FONTS[t.headingFont ?? 'system'] ?? HEADING_FONTS.system;
  const families = [font.google, 'Inter:wght@400;600'].filter(Boolean).join('&family=');
  return {
    headerBg,
    headerText: t.headerTextColor && HEX.test(t.headerTextColor) ? t.headerTextColor : contrastText(headerBg),
    accent,
    accentText: contrastText(accent),
    logoUrl: httpsUrl(t.logoUrl),
    websiteUrl: httpsUrl(t.websiteUrl),
    headingFont: font.stack,
    bodyFont: BODY_STACK,
    radius: t.squareButtons ? '0' : '9px',
    fontsHref: `https://fonts.googleapis.com/css2?family=${families}&display=swap`,
  };
}
