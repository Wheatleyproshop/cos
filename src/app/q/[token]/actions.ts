'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ServiceError } from '@/lib/services/common';
import { acceptQuoteByToken, findQuoteByToken } from '@/lib/services/quotes';
import { approveByCustomerAndInvoice } from '@/lib/services/shopify-invoices';
import { payBeforePrint } from '@/lib/shopify-invoice';

export async function acceptQuoteAction(token: string, _: { error?: string; message?: string } | null, fd: FormData): Promise<{ error?: string; message?: string }> {
  if (fd.get('agree') !== 'on') return { error: 'Please tick the box to confirm you agree to the terms.' };
  let trackingUrl: string;
  // Pay before print: approving sends the customer to the Shopify payment page; print starts once paid.
  const found = await findQuoteByToken(token);
  if (found && payBeforePrint(found.org, found.quote.specificationJson)) {
    const name = String(fd.get('acceptedName') ?? '').trim().slice(0, 120);
    if (!name) return { error: 'Please type your full name to approve.' };
    let pay: string | null;
    try {
      pay = (await approveByCustomerAndInvoice(found, name)).invoiceUrl;
    } catch (e) {
      if (e instanceof ServiceError) return { error: e.message };
      console.error('[COS quote acceptance → invoice]', e);
      return { error: 'Sorry, something went wrong. Nothing has been approved — please try again or contact the shop.' };
    }
    if (pay) redirect(pay);
    return { message: 'Thank you, your design is approved. We’ll email you a secure payment link shortly; we print your balls as soon as it’s paid.' };
  }
  try {
    const h = await headers();
    const res = await acceptQuoteByToken(token, String(fd.get('acceptedName') ?? ''), {
      ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: h.get('user-agent')?.slice(0, 300) ?? null,
    });
    trackingUrl = res.trackingUrl;
  } catch (e) {
    if (e instanceof ServiceError) return { error: e.message };
    console.error('[COS quote acceptance]', e);
    return { error: 'Sorry, something went wrong. Nothing has been approved — please try again or contact the shop.' };
  }
  redirect(new URL(trackingUrl).pathname + '?approved=1');
}
