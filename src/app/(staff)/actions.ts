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
  quickMove,
  recordPayment,
  restoreAttachment,
  setArchived,
  setNoteDeleted,
  setOrderDeleted,
  updateOrderProgress,
  voidPayment,
} from '@/lib/services/orders';
import {
  acceptQuoteInStore,
  addQuoteNote,
  closeQuote,
  createApprovalLink,
  createQuote,
  editQuote,
  restoreQuoteNotes,
  sendQuote,
  setQuoteDeleted,
  setQuoteNoteDeleted,
  updateQuoteNotes,
} from '@/lib/services/quotes';
import {
  changeOwnPassword,
  createUser,
  recheckSender,
  resetUserPassword,
  setAutomation,
  setCustomerDeleted,
  setUserDeleted,
  updateAutomations,
  updateCustomer,
  updatePaymentTracking,
  updateStoreSettings,
  updateThresholds,
  updateUser,
} from '@/lib/services/admin';
import { runBackup } from '@/lib/services/backups';
import { sendTestEmail } from '@/lib/services/test-email';
import { addBrand, addComponent, addModel, createFittingQuote, setCatalogActive, setCatalogRemoved, updateComponentUpcharge, updateModelPrice } from '@/lib/services/fitting';
import {
  addAccountsForCatalogueBrands,
  clearAccountLogo,
  restoreAccountNotes,
  saveAccount,
  setAccountActive,
  setAccountDeleted,
  setAccountLogo,
  updateAccountNotes,
} from '@/lib/services/accounts';
import { sendReportNow, updatePerformanceReport } from '@/lib/services/performance-report';
import {
  addWorkshopItem,
  checkInClubs,
  quickMoveJob,
  removeWorkshopItem,
  restoreJobNotes,
  restoreWorkshopItem,
  setJobDeleted,
  updateJobNotes,
  updateWorkshopProgress,
} from '@/lib/services/workshop';
import {
  addLine,
  archivePrebook,
  createPrebook,
  receiveAll,
  receiveStock,
  removeLine,
  restoreLine,
  restorePrebookNotes,
  setPrebookDeleted,
  setPrebookStatus,
  updatePrebook,
  updatePrebookNotes,
} from '@/lib/services/prebooks';
import { TEMPLATE_KEYS } from '@/lib/email/templates';
import { createCrestQuote, setCrestDesignLink, setCrestPositionRemoved, updateCrestPrices } from '@/lib/services/cresting';
import { addBall, addStarterBalls, createBallPrintQuote, setBallActive, setBallDesignLink, setBallPhoto, setBallRemoved, updateBall, updateBallPrice, updateSetupFee } from '@/lib/services/ball-printing';

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
        const o = await createOrder(ctx, data);
        // Back to the order pad, where the new order waits under "To place".
        target = `/?added=${o.orderNumber}`;
      }
    },
    fd,
  );
  if (res?.ok && target) redirect(target, RedirectType.replace);
  return res;
}

/* ── Orders ──────────────────────────────────────────────────────────── */

export async function updateProgressAction(orderId: string, _: FormState, fd: FormData) {
  let target = '';
  const res = await act(
    'staff',
    async (ctx) => {
      const r = await updateOrderProgress(ctx, orderId, {
        ...obj(fd),
        notify: !flag(fd, 'skipEmail'),
        collectWithBalance: flag(fd, 'collectWithBalance'),
      });
      // Saving closes the order and goes back to the order pad, saying what happened.
      target = `/?moved=${r.orderNumber}&to=${r.status}${r.emailed ? '&emailed=1' : ''}`;
      return 'Changes saved.';
    },
    fd,
  );
  if (res?.ok && target) redirect(target);
  return res;
}

/** Order pad: place an order straight from its card (in stock with an ETA, or out of stock). */
export async function quickPlaceAction(orderId: string, _: FormState, fd: FormData) {
  return act(
    'staff',
    async (ctx) => {
      const stock = fd.get('stock') === 'out' ? 'delayed' : 'ordered';
      const r = await quickMove(ctx, orderId, stock, { etaDate: String(fd.get('etaDate') ?? ''), supplierReference: String(fd.get('supplierReference') ?? '') });
      return `${r.orderNumber} placed${r.emailed ? ' — customer emailed' : ''}.`;
    },
    fd,
  );
}

/** Order pad: one-click Arrived / Collected. */
export async function quickMoveAction(orderId: string, to: 'ready' | 'collected', collectWithBalance = false) {
  return act('staff', async (ctx) => {
    const r = await quickMove(ctx, orderId, to, { collectWithBalance });
    return to === 'ready' ? `${r.orderNumber} ready${r.emailed ? ' — customer emailed' : ''}.` : `${r.orderNumber} collected.`;
  });
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
    return 'Attachment deleted.';
  });
}

export async function trackingLinkAction(orderId: string): Promise<FormState> {
  return act('staff', async (ctx) => ({ url: await createTrackingLink(ctx, orderId) }));
}

export async function deleteOrderAction(orderId: string, deleted: boolean) {
  return act('manager', async (ctx) => {
    await setOrderDeleted(ctx, orderId, deleted);
    return deleted ? 'Order deleted.' : 'Order restored.';
  });
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
    // Every email on the form: a key left out here would be saved as switched off.
    await updateAutomations(ctx, Object.fromEntries(TEMPLATE_KEYS.map((k) => [k, flag(fd, k)])));
    return 'Automations saved.';
  });
}

/** Switch one automatic email off (the template is built in, so "deleting" it means it's never sent) or back on. */
export async function emailOnOffAction(key: EmailAutomationKey, enabled: boolean) {
  return act('admin', async (ctx) => {
    await setAutomation(ctx, key, enabled);
    return enabled ? 'Email switched on.' : 'Email switched off.';
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

/** The builder posts its clubs as JSON; anything malformed becomes an empty list and fails validation. */
function parseBuilds(v: FormDataEntryValue | null): unknown[] {
  try {
    const parsed = JSON.parse(String(v ?? '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function fittingAction(_: FormState, fd: FormData): Promise<FormState> {
  let target = '';
  const res = await act(
    'staff',
    async (ctx) => {
      const q = await createFittingQuote(
        ctx,
        { ...obj(fd), builds: parseBuilds(fd.get('builds')) },
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

export async function catalogueRemoveAction(kind: 'brand' | 'model' | 'component', id: string, removed: boolean) {
  return act('manager', async (ctx) => {
    await setCatalogRemoved(ctx, kind, id, removed);
    return removed ? 'Deleted.' : 'Restored.';
  });
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

/* ── Clothing cresting ──────────────────────────────────────────────── */

export async function crestingAction(_: FormState, fd: FormData): Promise<FormState> {
  let target = '';
  const file = (name: string) => {
    const v = fd.get(name);
    return v instanceof File && v.size ? v : null;
  };
  const res = await act(
    'staff',
    async (ctx) => {
      const data = obj(fd);
      const q = await createCrestQuote(
        ctx,
        { ...data, garmentBrand: data.brand ?? '' },
        { front: file('front'), back: file('back'), logos: [file('logo0'), file('logo1'), file('logo2')], proof: file('proof') },
        { send: fd.get('intent') === 'send' },
      );
      target = `/quotes/${q.quoteNumber}`;
    },
    fd,
  );
  if (res?.ok && target) redirect(target);
  return res;
}

export async function crestDesignLinkAction(enabled: boolean) {
  return act('manager', async (ctx) => {
    await setCrestDesignLink(ctx, enabled);
    return enabled ? 'Design link switched on.' : 'Design link switched off.';
  });
}

export async function crestPositionAction(key: string, removed: boolean) {
  return act('manager', async (ctx) => {
    await setCrestPositionRemoved(ctx, key, removed);
    return removed ? 'Position deleted.' : 'Position restored.';
  });
}

export async function crestPricesAction(_: FormState, fd: FormData) {
  return act('manager', async (ctx) => {
    await updateCrestPrices(ctx, obj(fd));
    return 'Cresting prices saved.';
  }, fd);
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

export async function ballEditAction(id: string, _: FormState, fd: FormData) {
  return act('manager', async (ctx) => {
    await updateBall(ctx, id, obj(fd));
    return 'Ball updated.';
  }, fd);
}

export async function ballRemoveAction(id: string, removed: boolean) {
  return act('manager', async (ctx) => {
    await setBallRemoved(ctx, id, removed);
    return removed ? 'Deleted.' : 'Restored.';
  });
}

export async function ballActiveAction(id: string, active: boolean) {
  return act('manager', async (ctx) => {
    await setBallActive(ctx, id, active);
    return active ? 'Restored.' : 'Retired.';
  });
}

export async function designLinkAction(enabled: boolean) {
  return act('manager', async (ctx) => {
    await setBallDesignLink(ctx, enabled);
    return enabled ? 'Design link switched on.' : 'Design link switched off.';
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

export async function componentUpchargeAction(id: string, _: FormState, fd: FormData) {
  return act('manager', async (ctx) => {
    await updateComponentUpcharge(ctx, id, obj(fd));
    return 'Upcharge updated.';
  }, fd);
}

export async function performanceReportAction(_: FormState, fd: FormData) {
  return act('admin', async (ctx) => {
    await updatePerformanceReport(ctx, obj(fd));
    return 'Monthly report settings saved.';
  }, fd);
}

export async function sendReportNowAction() {
  return act('admin', async (ctx) => {
    const r = await sendReportNow(ctx);
    return `Sent the ${r.month} report to ${r.recipients.join(', ')}${r.simulated ? ' (simulated — no email provider configured)' : ''}.`;
  });
}

/* ── Supplier accounts ──────────────────────────────────────────────── */

export async function saveAccountAction(id: string | null, _: FormState, fd: FormData) {
  return act('manager', async (ctx) => {
    await saveAccount(ctx, id, obj(fd));
    return id ? 'Account updated.' : 'Account added.';
  }, fd);
}

export async function accountActiveAction(id: string, active: boolean) {
  return act('manager', async (ctx) => {
    await setAccountActive(ctx, id, active);
    return active ? 'Account restored.' : 'Account hidden.';
  });
}

export async function catalogueAccountsAction() {
  return act('manager', async (ctx) => {
    const n = await addAccountsForCatalogueBrands(ctx);
    return n ? `Added ${n} account card${n === 1 ? '' : 's'} — fill in the details for each.` : 'Every catalogue brand already has an account.';
  });
}

/* ── Pre-books ───────────────────────────────────────────────────────── */

export async function createPrebookAction(_: FormState, fd: FormData): Promise<FormState> {
  let target = '';
  const res = await act('manager', async (ctx) => {
    const p = await createPrebook(ctx, obj(fd));
    target = `/prebook/${p.reference}`;
  }, fd);
  if (res?.ok && target) redirect(target);
  return res;
}

export async function updatePrebookAction(id: string, _: FormState, fd: FormData) {
  return act('manager', async (ctx) => {
    await updatePrebook(ctx, id, obj(fd));
    return 'Pre-book updated.';
  }, fd);
}

export async function addPrebookLineAction(id: string, _: FormState, fd: FormData) {
  return act('manager', async (ctx) => {
    await addLine(ctx, id, obj(fd));
    return 'Line added.';
  }, fd);
}

export async function removePrebookLineAction(id: string, lineId: string) {
  return act('manager', async (ctx) => {
    await removeLine(ctx, id, lineId);
    return 'Line removed.';
  });
}

export async function prebookStatusAction(id: string, status: 'draft' | 'placed' | 'confirmed' | 'cancelled') {
  return act('manager', async (ctx) => {
    await setPrebookStatus(ctx, id, status);
    return 'Pre-book updated.';
  });
}

/** Pre-book list: book in everything outstanding in one click. */
export async function receiveAllPrebookAction(id: string) {
  return act('staff', async (ctx) => {
    await receiveAll(ctx, id);
    return 'All stock booked in.';
  });
}

export async function receivePrebookAction(id: string, _: FormState, fd: FormData) {
  return act('staff', async (ctx) => {
    const received: Record<string, number> = {};
    for (const [k, v] of fd.entries()) {
      if (k.startsWith('received:') && typeof v === 'string' && v.trim() !== '') received[k.slice(9)] = Number(v);
    }
    const status = await receiveStock(ctx, id, received);
    return status === 'delivered' ? 'Everything has arrived — pre-book delivered.' : 'Deliveries booked in.';
  }, fd);
}

export async function archivePrebookAction(id: string, archived: boolean) {
  return act('manager', async (ctx) => {
    await archivePrebook(ctx, id, archived);
    return archived ? 'Pre-book archived.' : 'Pre-book restored.';
  });
}

export async function accountLogoAction(id: string, _: FormState, fd: FormData) {
  return act('manager', async (ctx) => {
    const f = fd.get('logo');
    await setAccountLogo(ctx, id, f instanceof File && f.size ? f : null);
    return 'Logo saved.';
  });
}

export async function clearAccountLogoAction(id: string) {
  return act('manager', async (ctx) => {
    await clearAccountLogo(ctx, id);
    return 'Logo removed.';
  });
}

/* ── Workshop ────────────────────────────────────────────────────────── */

export async function checkInAction(_: FormState, fd: FormData): Promise<FormState> {
  let target = '';
  const res = await act('staff', async (ctx) => {
    let items: unknown[] = [];
    try {
      const parsed = JSON.parse(String(fd.get('items') ?? '[]'));
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      items = [];
    }
    const job = await checkInClubs(ctx, { ...obj(fd), items }, { notify: !flag(fd, 'skipEmail') });
    target = `/workshop/${job.reference}`;
  }, fd);
  if (res?.ok && target) redirect(target);
  return res;
}

export async function workshopProgressAction(id: string, _: FormState, fd: FormData) {
  let target = '';
  const res = await act('staff', async (ctx) => {
    const r = await updateWorkshopProgress(ctx, id, obj(fd), { notify: !flag(fd, 'skipEmail') });
    // Saving goes back to the workshop list, saying what happened.
    target = `/workshop?moved=${r.reference}&to=${r.status}${r.emailed ? '&emailed=1' : ''}`;
    return 'Job updated.';
  }, fd);
  if (res?.ok && target) redirect(target);
  return res;
}

/** Workshop list: one-click Start / Parts in / Ready / Collected. */
export async function quickJobAction(id: string, to: 'in_progress' | 'ready' | 'collected') {
  return act('staff', async (ctx) => {
    const r = await quickMoveJob(ctx, id, to);
    return `${r.reference} updated${r.emailed ? ' — customer emailed' : ''}.`;
  });
}

/** Workshop list: waiting for parts, with the reason the customer sees. */
export async function quickJobPartsAction(id: string, _: FormState, fd: FormData) {
  return act('staff', async (ctx) => {
    const r = await quickMoveJob(ctx, id, 'waiting_parts', { delayReason: String(fd.get('delayReason') ?? '') });
    return `${r.reference} waiting for parts${r.emailed ? ' — customer emailed' : ''}.`;
  }, fd);
}

export async function addWorkshopItemAction(id: string, _: FormState, fd: FormData) {
  return act('staff', async (ctx) => {
    await addWorkshopItem(ctx, id, obj(fd));
    return 'Club added.';
  }, fd);
}

export async function removeWorkshopItemAction(id: string, itemId: string) {
  return act('staff', async (ctx) => {
    await removeWorkshopItem(ctx, id, itemId);
    return 'Club removed.';
  });
}

export async function deleteJobAction(id: string, deleted: boolean) {
  return act('manager', async (ctx) => {
    await setJobDeleted(ctx, id, deleted);
    return deleted ? 'Job deleted.' : 'Job restored.';
  });
}

export async function deletePrebookAction(id: string, deleted: boolean) {
  return act('manager', async (ctx) => {
    await setPrebookDeleted(ctx, id, deleted);
    return deleted ? 'Pre-book deleted.' : 'Pre-book restored.';
  });
}

export async function deleteAccountAction(id: string, deleted: boolean) {
  return act('manager', async (ctx) => {
    await setAccountDeleted(ctx, id, deleted);
    return deleted ? 'Account deleted.' : 'Account restored.';
  });
}

export async function deleteCustomerAction(id: string, deleted: boolean) {
  return act('manager', async (ctx) => {
    await setCustomerDeleted(ctx, id, deleted);
    return deleted ? 'Customer deleted.' : 'Customer restored.';
  });
}

export async function deleteQuoteAction(quoteId: string, deleted: boolean) {
  return act('manager', async (ctx) => {
    await setQuoteDeleted(ctx, quoteId, deleted);
    return deleted ? 'Quote deleted.' : 'Quote restored.';
  });
}

export async function restoreWorkshopItemAction(jobId: string, itemId: string) {
  return act('staff', async (ctx) => {
    await restoreWorkshopItem(ctx, jobId, itemId);
    return 'Club restored.';
  });
}

export async function restorePrebookLineAction(prebookId: string, lineId: string) {
  return act('manager', async (ctx) => {
    await restoreLine(ctx, prebookId, lineId);
    return 'Line restored.';
  });
}

export async function voidPaymentAction(orderId: string, paymentId: string, _: FormState, fd: FormData) {
  return act('manager', async (ctx) => {
    await voidPayment(ctx, orderId, paymentId, fd.get('reason'));
    return 'Payment voided.';
  }, fd);
}

export async function restoreAttachmentAction(attachmentId: string) {
  return act('staff', async (ctx) => {
    await restoreAttachment(ctx, attachmentId);
    return 'Attachment restored.';
  });
}

export async function deleteUserAction(userId: string, deleted: boolean) {
  return act('admin', async (ctx) => {
    await setUserDeleted(ctx, userId, deleted);
    return deleted ? 'Team member deleted.' : 'Team member restored.';
  });
}

export async function deleteNoteAction(orderId: string, noteEventId: string, deleted: boolean) {
  return act('staff', async (ctx) => {
    await setNoteDeleted(ctx, orderId, noteEventId, deleted);
    return deleted ? 'Note deleted.' : 'Note restored.';
  });
}

export async function workshopNotesAction(jobId: string, _: FormState, fd: FormData) {
  return act('staff', async (ctx) => {
    await updateJobNotes(ctx, jobId, fd.get('notes'));
    return 'Notes saved.';
  }, fd);
}

export async function clearWorkshopNotesAction(jobId: string) {
  return act('staff', async (ctx) => {
    await updateJobNotes(ctx, jobId, '');
    return 'Notes deleted.';
  });
}

export async function restoreWorkshopNotesAction(jobId: string) {
  return act('staff', async (ctx) => {
    await restoreJobNotes(ctx, jobId);
    return 'Notes restored.';
  });
}

export async function addQuoteNoteAction(quoteId: string, _: FormState, fd: FormData) {
  return act('staff', async (ctx) => {
    await addQuoteNote(ctx, quoteId, obj(fd));
    return 'Note added.';
  }, fd);
}

export async function deleteQuoteNoteAction(quoteId: string, noteEventId: string, deleted: boolean) {
  return act('staff', async (ctx) => {
    await setQuoteNoteDeleted(ctx, quoteId, noteEventId, deleted);
    return deleted ? 'Note deleted.' : 'Note restored.';
  });
}

export async function quoteNotesAction(quoteId: string, _: FormState, fd: FormData) {
  return act('staff', async (ctx) => {
    await updateQuoteNotes(ctx, quoteId, fd.get('notes'));
    return 'Notes saved.';
  }, fd);
}

export async function clearQuoteNotesAction(quoteId: string) {
  return act('staff', async (ctx) => {
    await updateQuoteNotes(ctx, quoteId, '');
    return 'Notes deleted.';
  });
}

export async function restoreQuoteNotesAction(quoteId: string) {
  return act('staff', async (ctx) => {
    await restoreQuoteNotes(ctx, quoteId);
    return 'Notes restored.';
  });
}

export async function prebookNotesAction(prebookId: string, _: FormState, fd: FormData) {
  return act('manager', async (ctx) => {
    await updatePrebookNotes(ctx, prebookId, fd.get('notes'));
    return 'Notes saved.';
  }, fd);
}

export async function clearPrebookNotesAction(prebookId: string) {
  return act('manager', async (ctx) => {
    await updatePrebookNotes(ctx, prebookId, '');
    return 'Notes deleted.';
  });
}

export async function restorePrebookNotesAction(prebookId: string) {
  return act('manager', async (ctx) => {
    await restorePrebookNotes(ctx, prebookId);
    return 'Notes restored.';
  });
}

export async function accountNotesAction(accountId: string, _: FormState, fd: FormData) {
  return act('manager', async (ctx) => {
    await updateAccountNotes(ctx, accountId, fd.get('notes'));
    return 'Notes saved.';
  }, fd);
}

export async function clearAccountNotesAction(accountId: string) {
  return act('manager', async (ctx) => {
    await updateAccountNotes(ctx, accountId, '');
    return 'Notes deleted.';
  });
}

export async function restoreAccountNotesAction(accountId: string) {
  return act('manager', async (ctx) => {
    await restoreAccountNotes(ctx, accountId);
    return 'Notes restored.';
  });
}
