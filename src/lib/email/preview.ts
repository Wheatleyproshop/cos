import 'server-only';
import type { EmailAutomationKey, Organisation } from '@/db/schema';
import { addDays, todayInTz } from '../format';
import { previewSource } from '../queries';
import { brandingFor } from './outbox';
import { renderEmail } from './templates';

/** Renders a template with the shop's latest real order (or sample data) for previews and test sends. */
export async function renderSample(org: Organisation, template: EmailAutomationKey, actionUrl = '#preview') {
  const src = await previewSource(org);
  const today = todayInTz(org.timezone);
  const sample = src
    ? { customerName: src.c.name, reference: src.o.orderNumber, brand: src.o.brand, product: src.o.product, specification: src.o.specificationText, totalPence: src.o.totalGrossPence }
    : { customerName: 'James Wilson', reference: 'COS-1048', brand: 'PING', product: 'G440 MAX Driver', specification: '10.5° / Alta CB Blue 50 Stiff / Golf Pride MCC +4', totalPence: 52900 };
  if (template.startsWith('workshop_')) {
    const items = [
      { club: 'Irons 5-PW', work: 'Regrip', parts: 'Golf Pride MCC, midsize', quantity: 6, pricePence: 7800 },
      { club: 'Driver', work: 'Loft & lie adjustment', parts: '', quantity: 1, pricePence: 1000 },
    ];
    const total = items.reduce((s, i) => s + i.pricePence, 0);
    return renderEmail(template, {
      store: brandingFor(org),
      customerName: src?.c.name ?? 'James Wilson',
      reference: 'WS-1001',
      brand: 'Workshop',
      product: '2 clubs',
      specification: items.map((i) => `${i.club}: ${i.work}`).join('\n'),
      totalPence: total,
      etaDate: addDays(today, 5),
      previousEtaDate: template === 'workshop_delayed' ? addDays(today, 2) : null,
      etaReason: template === 'workshop_delayed' ? 'We’re waiting for the midsize grips to arrive from Golf Pride.' : '',
      fit: {
        kind: 'cos-configure', version: 2, totalPence: total,
        builds: [{ title: 'Workshop job WS-1001', totalPence: total, lines: items.map((i) => ({ label: i.quantity > 1 ? `${i.club} ×${i.quantity}` : i.club, value: [i.work, i.parts].filter(Boolean).join(' — '), pricePence: i.pricePence })) }],
      },
    });
  }
  return renderEmail(template, {
    store: brandingFor(org),
    ...sample,
    paidPence: 10000,
    balancePence: sample.totalPence - 10000,
    depositRequiredPence: 10000,
    etaDate: addDays(today, 7),
    previousEtaDate: addDays(today, 3),
    etaReason: template === 'eta_revised' ? 'The manufacturer has told us the shaft is on back order.' : '',
    leadTime: '2–3 weeks',
    validUntil: addDays(today, 14),
    actionUrl,
  });
}
