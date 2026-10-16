import { Resend } from 'resend';
import type { Organisation } from '@/db/schema';

/**
 * Who customer emails come from.
 * 1. The retailer's own address (e.g. orders@desirablegolf.co.uk) once its domain is verified in Resend.
 * 2. Otherwise a per-shop address on the COS platform domain, e.g. desirable-golf@mail.cosgolf.co.uk
 *    (EMAIL_FROM_DOMAIN), or the single EMAIL_FROM address.
 * The display name is always the shop's name and replies always go to the shop's reply-to address.
 */
export function senderAddress(org: Pick<Organisation, 'slug' | 'senderEmail' | 'senderVerifiedAt'>): string {
  if (org.senderEmail && org.senderVerifiedAt) return org.senderEmail;
  const domain = process.env.EMAIL_FROM_DOMAIN?.trim();
  if (domain) return `${org.slug}@${domain}`;
  return process.env.EMAIL_FROM || 'orders@example.com';
}

export function fromHeader(org: Pick<Organisation, 'slug' | 'storeName' | 'senderEmail' | 'senderVerifiedAt'>): string {
  const display = org.storeName.replace(/["<>\r\n]/g, '').trim() || 'Orders';
  return `"${display}" <${senderAddress(org)}>`;
}

export type DomainCheck = { verified: boolean; domain: string; detail: string };

/** Asks Resend whether the address's domain is verified for sending on the COS account. */
export async function checkSenderDomain(email: string): Promise<DomainCheck> {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (!process.env.RESEND_API_KEY) {
    return { verified: false, domain, detail: 'No email provider is configured yet, so the COS address is used.' };
  }
  const res = await new Resend(process.env.RESEND_API_KEY).domains.list();
  if (res.error) return { verified: false, domain, detail: `Couldn’t check with Resend: ${res.error.message}` };
  const match = res.data?.data.find((d) => d.name.toLowerCase() === domain);
  if (!match) {
    return { verified: false, domain, detail: `${domain} hasn’t been added to COS’s email service yet. Ask COS support to set it up.` };
  }
  if (match.status !== 'verified') {
    return { verified: false, domain, detail: `${domain} is waiting for DNS verification (status: ${match.status.replace(/_/g, ' ')}).` };
  }
  return { verified: true, domain, detail: `${domain} is verified.` };
}
