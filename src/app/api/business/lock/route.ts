import { cookies } from 'next/headers';
import { BUSINESS_COOKIE } from '@/lib/business-lock';

/** Called by the page when the owner leaves the Business area or closes the tab: lock it straight away. */
export async function POST() {
  (await cookies()).delete(BUSINESS_COOKIE);
  return new Response(null, { status: 204 });
}
