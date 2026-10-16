import 'server-only';
import { unstable_rethrow } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { staffActor } from './audit';
import { ForbiddenError, requireStaff, type Role, type Staff } from './auth';
import { ServiceError, type Ctx } from './services/common';

export type FormState = {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  url?: string;
  /** Echo of submitted values so forms keep input after a validation error. */
  values?: Record<string, string>;
} | null;

export function ctxFor(staff: Staff): Ctx {
  // On a shared counter login, record the person who picked their name, noting the login used.
  const name = staff.sharedLoginName ? `${staff.name} (${staff.sharedLoginName} login)` : staff.name;
  return { org: staff.org, actor: staffActor({ id: staff.id, name }), userId: staff.id, role: staff.role };
}

export function formValues(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === 'string' && !k.startsWith('$')) out[k] = v;
  return out;
}

/**
 * Wraps a server action: authenticates, runs, revalidates and turns known
 * errors into friendly form state. Unknown errors are logged, not leaked.
 */
export async function act(
  min: Role,
  fn: (ctx: Ctx, staff: Staff) => Promise<string | { message?: string; url?: string } | void>,
  fd?: FormData,
): Promise<FormState> {
  try {
    const staff = await requireStaff(min);
    const res = await fn(ctxFor(staff), staff);
    revalidatePath('/', 'layout');
    if (typeof res === 'string') return { ok: true, message: res };
    return { ok: true, ...(res ?? {}) };
  } catch (e) {
    unstable_rethrow(e);
    const values = fd ? formValues(fd) : undefined;
    if (e instanceof ServiceError) return { error: e.message, fieldErrors: e.fieldErrors, values };
    if (e instanceof ForbiddenError) return { error: e.message, values };
    console.error('[COS action error]', e);
    return { error: 'Something went wrong and nothing was saved. Please try again.', values };
  }
}
