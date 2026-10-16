'use server';

import { redirect, RedirectType } from 'next/navigation';
import { act, type FormState } from '@/lib/action-utils';
import { logout } from '@/lib/auth';
import type { BackupProvider, EmailAutomationKey } from '@/db/schema';
import {
  addAttachment,
  addNote,
  archiveAttachment,
  createOrder,
  createTrackingLink,
  editOrderDetails,
  recordPayment,
  setArchived,
  updateOrderProgress,
} from '@/lib/services/orders';
import { acceptQuoteInStore, closeQuote, createApprovalLink, createQuote, editQuote, sendQuote } from '@/lib/services/quotes';
import {
  changeOwnPassword,
  recheckSender,
  resetUserPassword,
  createUser,
  updateAutomations,
  updateCustomer,
  updateStoreSettings,
  updateThresholds,
  updatePaymentTracking,
  updateUser,
} from '@/lib/services/admin';
import { runBackup } from '@/lib/services/backups';
import { sendTestEmail } from '@/lib/services/test-email';
import { addBrand, addComponent, addModel, createFittingQuote, setCatalogActive, updateModelPrice } from '@/lib/services/fitting';
import { addBall, addStarterBalls, createBallPrintQuote, setBallActive, setBallPhoto, updateBallPrice, updateSetupFee } from '@/lib/services/ball-printing';

const obj = (fd: FormData) => Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === 'string'));
const flag = (fd: FormData, name: string) => fd.get(name) === 'on' || fd.get(name) === 'true';

/* ── Create ──────────────────────────────────────────────────────────── */

export async function createRequestAction(_: FormState, fd: FormData): Promise<FormState> {
  let target = '';
  const res = await act(
    'staff',
    async (ctx) => {
      const data = obj(fd);
      if (data.mode === 'quote') {
        const q = await createQuote(ctx, data, { send: flag(fd, 'sendNow') });
        target = `/quotes/${q.quoteNumber}`;
      } else {
        const o = await createOrder(ctx, data, { notify: !flag(fd, 'skipEmail') });
        target = `/orders/${o.orderNumber}`;
      }
    },
    fd,
  );
  if (res?.ok && target) redirect(target, RedirectType.replace);
  return res;
}

/* ── Orders ──────────────────────────────────────────────────────────── */

export async function updateProgressAction(orderId: string, _: FormState, fd: FormData) {
  return act(
    'staff',
    async (ctx) => {
      await updateOrderProgress(ctx, orderId, {
        ...obj(fd),
        notify: !flag(fd, 'skipEmail'),
        collectWithBalance: flag(fd, 'collectWithBalance'),
      });
      return 'Changes saved.';
    },
    fd,
  );
}

export async function editOrderAction(orderId: string, _: FormState, fd: FormData) {
  return act('staff', async (ctx) => {
    await editOrderDetails(ctx, orderId, obj(fd));
    return 'Order details updated.';
  }, fd);
}

export async function recordPaymentAction(orderId: string, _: FormState, fd: FormData) {
  return act('staff', async (ctx) => {
    await recordPayment(ctx, orderId, obj(fd));
    return 'Payment recorded.';
  }, fd);
}

export async function addNoteAction(orderId: string, _: FormState, fd: FormData) {
  return act('staff', async (ctx) => {
    await addNote(ctx, orderId, obj(fd));
    return 'Note added.';
  }, fd);
}

export async function uploadAttachmentAction(orderId: string, _: FormState, fd: FormData) {
  return act('staff', async (ctx) => {
    await addAttachment(ctx, orderId, fd.get('file') as File, obj(fd));
    return 'File attached.';
  });
}

export async function archiveAttachmentAction(attachmentId: string) {
  return act('staff', async (ctx) => {
    await archiveAttachment(ctx, attachmentId);
    return 'Attachment archived.';
  });
}

export async function trackingLinkAction(orderId: string): Promise<FormState> {
  return act('staff', async (ctx) => ({ url: await createTrackingLink(ctx, orderId) }));
}

export async function archiveOrderAction(orderId: string, archived: boolean) {
  return act('manager', async (ctx) => {
    await setArchived(ctx, orderId, archived);
    return archived ? 'Order archived.' : 'Order restored.';
  });
}

/* ── Quotes ──────────────────────────────────────────────────────────── */

export async function sendQuoteAction(quoteId: string) {
  return act('staff', async (ctx) => {
    await sendQuote(ctx, quoteId);
    return 'Approval email sent with a fresh link.';
  });
}

export async function approvalLinkAction(quoteId: string): Promise<FormState> {
  return act('staff', async (ctx) => ({ url: await createApprovalLink(ctx, quoteId) }));
}

export async function editQuoteAction(quoteId: string, _: FormState, fd: FormData) {
  return act('staff', async (ctx) => {
    await editQuote(ctx, quoteId, obj(fd));
    return 'Quote updated.';
  }, fd);
}

export async function acceptInStoreAction(quoteId: string, _: FormState, fd: FormData): Promise<FormState> {
  let target = '';
  const res = await act('staff', async (ctx) => {
    const order = await acceptQuoteInStore(ctx, quoteId, String(fd.get('acceptedName') ?? ''));
    target = `/orders/${order.orderNumber}`;
  }, fd);
  if (res?.ok && target) redirect(target, RedirectType.replace);
  return res;
}

export async function closeQuoteAction(quoteId: string, outcome: 'declined' | 'cancelled') {
  return act('staff', async (ctx) => {
    await closeQuote(ctx, quoteId, outcome);
    return outcome === 'declined' ? 'Quote marked as declined.' : 'Quote cancelled.';
  });
}

/* ── Customers ───────────────────────────────────────────────────────── */

export async function updateCustomerAction(customerId: string, _: FormState, fd: FormData) {
  return act('staff', async (ctx) => {
    await updateCustomer(ctx, customerId, obj(fd));
    return 'Customer updated.';
  }, fd);
}

/* ── Settings ────────────────────────────────────────────────────────── */

export async function storeSettingsAction(_: FormState, fd: FormData) {
  return act('admin', (ctx) => updateStoreSettings(ctx, obj(fd)), fd);
}

export async function recheckSenderAction() {
  return act('admin', (ctx) => recheckSender(ctx));
}

export async function automationsAction(_: FormState, fd: FormData) {
  return act('admin', async (ctx) => {
    const keys: EmailAutomationKey[] = ['order_confirmation', 'quote_approval', 'eta_revised', 'ready_for_collection', 'collection_reminder'];
    await updateAutomations(ctx, Object.fromEntries(keys.map((k) => [k, flag(fd, k)])));
    return 'Automations saved.';
  });
}

export async function thresholdsAction(_: FormState, fd: FormData) {
  return act('admin', async (ctx) => {
    await updateThresholds(ctx, obj(fd));
    return 'Attention rules saved.';
  }, fd);
}

export async function createUserAction(_: FormState, fd: FormData) {
  return act('admin', async (ctx) => {
    await createUser(ctx, obj(fd));
    return 'Team member added. Share their temporary password with them in person.';
  }, fd);
}

export async function updateUserAction(userId: string, patch: { role?: 'admin' | 'manager' | 'staff'; active?: boolean }) {
  return act('admin', async (ctx) => {
    await updateUser(ctx, userId, patch);
    return 'Team member updated.';
  });
}

export async function changePasswordAction(_: FormState, fd: FormData) {
  return act('staff', async (ctx) => {
    await changeOwnPassword(ctx, obj(fd));
    return 'Password changed.';
  });
}

export async function backupNowAction(provider: BackupProvider) {
  return act('admin', async (ctx) => {
    await runBackup(ctx.org, provider, ctx.actor, ctx.userId);
    return 'Backup completed.';
  });
}

export async function logoutAction() {
  await logout();
  redirect('/login');
}

/* ── Custom Fitting & catalogue ─────────────────────────────────────── */

export async function fittingAction(_: FormState, fd: FormData): Promise<FormState> {
  let target = '';
  const res = await act(
    'staff',
    async (ctx) => {
      const q = await createFittingQuote(
        ctx,
        { ...obj(fd), componentIds: fd.getAll('componentIds').map(String) },
        { send: fd.get('intent') === 'send' },
      );
      target = `/quotes/${q.quoteNumber}`;
    },
    fd,
  );
  if (res?.ok && target) redirect(target);
  return res;
}

export async function catalogueAction(kind: 'brand' | 'model' | 'component', _: FormState, fd: FormData) {
  return act('manager', async (ctx) => {
    if (kind === 'brand') await addBrand(ctx, obj(fd));
    else if (kind === 'model') await addModel(ctx, obj(fd));
    else await addComponent(ctx, obj(fd));
    return 'Added to the catalogue.';
  }, fd);
}

export async function catalogueActiveAction(kind: 'brand' | 'model' | 'component', id: string, active: boolean) {
  return act('manager', async (ctx) => {
    await setCatalogActive(ctx, kind, id, active);
    return active ? 'Restored.' : 'Retired.';
  });
}

export async function sendTestEmailAction(template: string, _: FormState, fd: FormData) {
  return act('admin', (ctx) => sendTestEmail(ctx, { template, to: fd.get('to') }), fd);
}

export async function resetUserPasswordAction(userId: string) {
  return act('admin', async (ctx) => {
    const temp = await resetUserPassword(ctx, userId);
    return { message: `New temporary password: ${temp} — shown once. They can change it after signing in (or use Forgot password).` };
  });
}

export async function paymentTrackingAction(_: FormState, fd: FormData) {
  return act('admin', async (ctx) => {
    const on = fd.get('paymentTracking') === 'on';
    await updatePaymentTracking(ctx, on);
    return on ? 'Payments section switched on.' : 'Payments section switched off — payments are taken at your till.';
  });
}

/* ── Ball printing ──────────────────────────────────────────────────── */

export async function ballPrintAction(_: FormState, fd: FormData): Promise<FormState> {
  let target = '';
  const file = (name: string) => {
    const v = fd.get(name);
    return v instanceof File && v.size ? v : null;
  };
  const res = await act(
    'staff',
    async (ctx) => {
      const q = await createBallPrintQuote(
        ctx,
        { ...obj(fd), textLines: fd.getAll('textLines').map(String) },
        { logo: file('logo'), proof: file('proof') },
        { send: fd.get('intent') === 'send' },
      );
      target = `/quotes/${q.quoteNumber}`;
    },
    fd,
  );
  if (res?.ok && target) redirect(target);
  return res;
}

export async function addBallAction(_: FormState, fd: FormData) {
  return act('manager', async (ctx) => {
    await addBall(ctx, obj(fd));
    return 'Ball added to your range.';
  }, fd);
}

export async function starterBallsAction() {
  return act('manager', async (ctx) => {
    await addStarterBalls(ctx);
    return 'Starter range added. Check the prices match yours.';
  });
}

export async function ballPriceAction(id: string, _: FormState, fd: FormData) {
  return act('manager', async (ctx) => {
    await updateBallPrice(ctx, id, obj(fd));
    return 'Price updated.';
  }, fd);
}

export async function ballActiveAction(id: string, active: boolean) {
  return act('manager', async (ctx) => {
    await setBallActive(ctx, id, active);
    return active ? 'Restored.' : 'Retired.';
  });
}

export async function setupFeeAction(_: FormState, fd: FormData) {
  return act('manager', async (ctx) => {
    await updateSetupFee(ctx, obj(fd));
    return 'Setup fee saved.';
  }, fd);
}

export async function ballPhotoAction(id: string, _: FormState, fd: FormData) {
  return act('manager', async (ctx) => {
    const f = fd.get('photo');
    await setBallPhoto(ctx, id, f instanceof File && f.size ? f : null);
    return 'Photo saved.';
  });
}

export async function modelPriceAction(id: string, _: FormState, fd: FormData) {
  return act('manager', async (ctx) => {
    await updateModelPrice(ctx, id, obj(fd));
    return 'Price updated.';
  }, fd);
}
