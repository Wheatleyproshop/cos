import { requireBusiness } from '@/lib/business-lock';
import { fileResponse } from '@/lib/file-response';
import { payslipFile } from '@/lib/services/business/payroll';

/** An uploaded payslip PDF, decrypted for the owner only. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await requireBusiness({ renew: true });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
  const f = await payslipFile(staff.organisationId, id);
  if (!f) return new Response('Not found', { status: 404 });
  return fileResponse(f.body, 'application/pdf', f.name);
}
