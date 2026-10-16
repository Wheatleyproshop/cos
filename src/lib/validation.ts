import { z } from 'zod';
import { ATTACHMENT_CATEGORIES, PAYMENT_KINDS, PAYMENT_METHODS } from '@/db/schema';
import { parseMoneyToPence } from './format';
import { ServiceError } from './services/common';

const MAX_PENCE = 10_000_000_00; // £10m sanity ceiling

const text = (max: number) => z.string().trim().max(max, `Keep this under ${max} characters`);
const required = (label: string, max = 200) => text(max).min(1, `${label} is required`);
const isoDate = z
  .string()
  .trim()
  .refine((s) => s === '' || /^\d{4}-\d{2}-\d{2}$/.test(s), 'Use a valid date')
  .transform((s) => (s === '' ? null : s));

const money = (label: string, opts: { optional?: boolean } = {}) =>
  z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((v, ctx) => {
      if ((v === '' || v === null || v === undefined) && opts.optional) return 0;
      const p = parseMoneyToPence(v);
      if (p === null || p < 0 || p > MAX_PENCE) {
        ctx.addIssue({ code: 'custom', message: `${label} must be a valid amount, e.g. 529.00` });
        return z.NEVER;
      }
      return p;
    });

export const customerFields = {
  customerName: required('Customer name', 120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  phone: text(40).default(''),
};

export const productFields = {
  brand: required('Brand', 80),
  product: required('Product', 160),
  sku: text(80).default(''),
  specificationText: required('Specification', 4000),
  totalGrossPence: money('Total price'),
};

export const orderCreateSchema = z
  .object({
    ...customerFields,
    ...productFields,
    depositPence: money('Deposit', { optional: true }),
    depositMethod: z.enum(PAYMENT_METHODS).default('card'),
    etaDate: isoDate,
    supplierReference: text(120).default(''),
    internalNotes: text(4000).default(''),
  })
  .refine((v) => v.depositPence <= v.totalGrossPence, { message: 'Deposit cannot exceed the total price', path: ['depositPence'] });

export const quoteCreateSchema = z
  .object({
    ...customerFields,
    ...productFields,
    depositRequiredPence: money('Deposit required', { optional: true }),
    estimatedLeadTime: text(120).default(''),
    validUntil: isoDate,
    internalNotes: text(4000).default(''),
  })
  .refine((v) => v.depositRequiredPence <= v.totalGrossPence, {
    message: 'Deposit cannot exceed the total price',
    path: ['depositRequiredPence'],
  });

export const orderUpdateSchema = z.object({
  status: z.enum(['place_order', 'ordered', 'delayed', 'ready', 'collected']),
  etaDate: isoDate,
  etaReason: text(500).default(''),
  supplierReference: text(120).default(''),
  notify: z.boolean().default(true),
  collectWithBalance: z.boolean().default(false),
});

export const orderEditSchema = z.object({
  ...productFields,
  supplier: text(120).default(''),
  supplierNotes: text(2000).default(''),
  internalNotes: text(4000).default(''),
});

export const quoteEditSchema = z.object({
  ...productFields,
  depositRequiredPence: money('Deposit required', { optional: true }),
  estimatedLeadTime: text(120).default(''),
  validUntil: isoDate,
  internalNotes: text(4000).default(''),
});

export const paymentSchema = z.object({
  kind: z.enum(PAYMENT_KINDS),
  amountPence: money('Amount').refine((p) => p > 0, 'Amount must be more than £0'),
  method: z.enum(PAYMENT_METHODS),
  reference: text(120).default(''),
});

export const noteSchema = z.object({ note: required('Note', 2000) });

export const attachmentMetaSchema = z.object({
  category: z.enum(ATTACHMENT_CATEGORIES).default('other'),
  visibility: z.enum(['internal', 'customer-visible']).default('internal'),
});

export const customerEditSchema = z.object({
  name: required('Name', 120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  phone: text(40).default(''),
  notes: text(4000).default(''),
});

export const storeSettingsSchema = z.object({
  storeName: required('Store name', 120),
  replyToEmail: z.string().trim().email('Enter a valid reply-to email'),
  collectionLocation: text(300).default(''),
  storePhone: text(40).default(''),
  openingHours: text(300).default(''),
  brandColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #193b2c'),
  quoteTerms: text(4000).default(''),
});

export const thresholdsSchema = z.object({
  readyUncollectedDays: z.coerce.number().int().min(1).max(90),
  quoteFollowupDays: z.coerce.number().int().min(1).max(90),
  missingSupplierRefDays: z.coerce.number().int().min(0).max(90),
});

export const userCreateSchema = z.object({
  name: required('Name', 120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  role: z.enum(['admin', 'manager', 'staff']),
  password: z.string().min(10, 'Use at least 10 characters').max(200),
});

export const passwordChangeSchema = z
  .object({
    current: z.string().min(1, 'Enter your current password'),
    next: z.string().min(10, 'Use at least 10 characters').max(200),
    confirm: z.string(),
  })
  .refine((v) => v.next === v.confirm, { message: 'Passwords do not match', path: ['confirm'] });

/** Parses or throws a ServiceError with per-field messages. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const fieldErrors: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const k = String(issue.path[0] ?? '_');
    fieldErrors[k] ??= issue.message;
  }
  throw new ServiceError('Please check the highlighted fields.', fieldErrors);
}
