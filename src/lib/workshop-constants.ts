import type { WorkshopStatus } from '@/db/schema';

/** Shared by the workshop service and its forms. */
export const WORKSHOP_STATUS_LABELS: Record<WorkshopStatus, string> = {
  checked_in: 'Checked in',
  in_progress: 'In progress',
  waiting_parts: 'Waiting for parts',
  ready: 'Ready to collect',
  collected: 'Collected',
  cancelled: 'Cancelled',
};

export const WORK_TYPES = [
  'Regrip',
  'Reshaft',
  'Loft & lie adjustment',
  'Length adjustment',
  'Swing weight',
  'Ferrule replacement',
  'Head re-glue / repair',
  'Putter work',
  'Clean & check',
  'Custom build',
  'Other',
];

export const CLUB_SUGGESTIONS = [
  'Driver', '3 wood', '5 wood', '7 wood', 'Hybrid', 'Driving iron',
  '3 iron', '4 iron', '5 iron', '6 iron', '7 iron', '8 iron', '9 iron', 'PW', 'GW', 'SW', 'LW', 'Wedge',
  'Putter', 'Irons 4-PW', 'Irons 5-PW', 'Full set', 'Whole bag',
];
