import type { Organisation } from '@/db/schema';

/**
 * Subscription tiers. Core order management is in every plan; advanced
 * features are gated here so the rest of the app only asks `hasFeature`.
 */
export type Feature =
  | 'backup.cos_hosted'
  | 'backup.google_drive'
  | 'backup.dropbox'
  | 'reporting.enhanced'
  | 'configure';

export const PLANS: Record<Organisation['plan'], { label: string; staffLimit: number; monthlyEmails: number; features: Feature[] }> = {
  trial: {
    label: 'Trial',
    staffLimit: 5,
    monthlyEmails: 500,
    features: ['backup.cos_hosted', 'backup.google_drive', 'backup.dropbox', 'reporting.enhanced', 'configure'],
  },
  core: { label: 'Core', staffLimit: 5, monthlyEmails: 1000, features: ['backup.cos_hosted'] },
  pro: {
    label: 'Pro',
    staffLimit: 25,
    monthlyEmails: 5000,
    features: ['backup.cos_hosted', 'backup.google_drive', 'backup.dropbox', 'reporting.enhanced', 'configure'],
  },
};

export function hasFeature(org: Pick<Organisation, 'plan' | 'trialEndsAt'>, feature: Feature): boolean {
  if (org.plan === 'trial' && org.trialEndsAt && org.trialEndsAt < new Date()) return false;
  return PLANS[org.plan].features.includes(feature);
}
