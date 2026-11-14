/**
 * Text messages to customers, sent through Twilio. Dormant until the shop connects an account by
 * setting TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM (a UK number, or an alphanumeric
 * sender name of up to 11 letters such as "DesirableGlf") in the hosting environment. Without them,
 * texts are recorded as simulated, like email without a provider.
 */

export function smsConfig() {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const from = process.env.TWILIO_FROM?.trim();
  return sid && token && from ? { sid, token, from } : null;
}

/** A UK mobile number in international form (+447…), or null for landlines, overseas or nonsense. */
export function ukMobile(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('00')) d = `+${d.slice(2)}`;
  if (d.startsWith('+44')) d = `0${d.slice(3).replace(/^0/, '')}`;
  else if (d.startsWith('44') && d.length === 12) d = `0${d.slice(2)}`;
  return /^07\d{9}$/.test(d) ? `+44${d.slice(1)}` : null;
}

/** Plain characters only, so a message fits the cheaper 160-character text format (curly quotes and dashes don't). */
export function smsSafe(text: string) {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

const first = (name: string) => name.trim().split(/\s+/)[0] || 'there';

/** "Ready to collect" text for an order or workshop job. Kept short: one or two texts' worth. */
export function readyText(o: {
  storeName: string; customerName: string; reference: string; what: string; balancePence?: number; openingHours?: string; storePhone?: string;
}) {
  const what = o.what.length > 40 ? `${o.what.slice(0, 38).trim()}..` : o.what;
  const owed = o.balancePence && o.balancePence > 0 ? ` Balance to pay: £${(o.balancePence / 100).toFixed(2)}.` : '';
  const hours = o.openingHours && o.openingHours.length <= 40 ? ` Open ${o.openingHours}.` : '';
  return smsSafe(`${o.storeName}: Hi ${first(o.customerName)}, your ${what} (${o.reference}) is ready to collect.${owed}${hours} See you soon!`);
}

export type SmsResult = { ok: true; id: string; simulated: boolean } | { ok: false; error: string };

/** Sends one text. Never throws: failures come back as { ok: false } to be logged on the message. */
export async function sendSms(to: string, body: string): Promise<SmsResult> {
  const cfg = smsConfig();
  if (!cfg) {
    console.info(`[COS sms · simulated] to=${to} "${body}"`);
    return { ok: true, id: `simulated-sms-${Date.now()}`, simulated: true };
  }
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.sid)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.sid}:${cfg.token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: cfg.from, Body: body }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!res.ok || !json.sid) return { ok: false, error: json.message ?? `Text provider error ${res.status}` };
    return { ok: true, id: json.sid, simulated: false };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
