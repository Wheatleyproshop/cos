/** "12 Nov" style date for a YYYY-MM-DD string (no time-zone shift). */
export function shortDate(iso: string) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}
