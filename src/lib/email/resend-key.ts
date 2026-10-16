/**
 * The Resend API key. Looked up case-insensitively because Vercel secrets can't be
 * renamed after saving, and a mistyped capital (e.g. RESEND_API_KEy) shouldn't stop email.
 */
export function resendApiKey(): string | undefined {
  if (process.env.RESEND_API_KEY) return process.env.RESEND_API_KEY.trim();
  const name = Object.keys(process.env).find((k) => k.toUpperCase() === 'RESEND_API_KEY');
  return name ? process.env[name]?.trim() || undefined : undefined;
}
