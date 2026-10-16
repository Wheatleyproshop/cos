import type { Metadata } from 'next';
import Link from 'next/link';
import { MessageBadge, PageHeader } from '@/components/views';
import type { EmailAutomationKey } from '@/db/schema';
import { requireStaff } from '@/lib/auth';
import { templateName } from '@/lib/audit';
import { brandingFor } from '@/lib/email/outbox';
import { fromHeader } from '@/lib/email/sender';
import { renderEmail, TEMPLATE_KEYS } from '@/lib/email/templates';
import { addDays, stamp, todayInTz } from '@/lib/format';
import { getMessage, listMessages, previewSource } from '@/lib/queries';

export const metadata: Metadata = { title: 'Email previews' };

export default async function EmailsPage({ searchParams }: { searchParams: Promise<{ template?: string; view?: string }> }) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const tz = staff.org.timezone;
  const template = (TEMPLATE_KEYS as string[]).includes(sp.template ?? '') ? (sp.template as EmailAutomationKey) : 'order_confirmation';
  const viewing = sp.view ? await getMessage(staff.org, sp.view) : null;
  const [log, src] = await Promise.all([listMessages(staff.org, 60), previewSource(staff.org)]);

  const today = todayInTz(tz);
  const sample = src
    ? { customerName: src.c.name, reference: src.o.orderNumber, brand: src.o.brand, product: src.o.product, specification: src.o.specificationText, totalPence: src.o.totalGrossPence }
    : { customerName: 'James Wilson', reference: 'COS-1048', brand: 'PING', product: 'G440 MAX Driver', specification: '10.5° / Alta CB Blue 50 Stiff / Golf Pride MCC +4', totalPence: 52900 };
  const preview = renderEmail(template, {
    store: brandingFor(staff.org),
    ...sample,
    paidPence: 10000,
    balancePence: sample.totalPence - 10000,
    depositRequiredPence: 10000,
    etaDate: addDays(today, 7),
    previousEtaDate: addDays(today, 3),
    etaReason: template === 'eta_revised' ? 'The manufacturer has told us the shaft is on back order.' : '',
    leadTime: '2–3 weeks',
    validUntil: addDays(today, 14),
    actionUrl: '#preview',
  });

  return (
    <>
      <PageHeader staff={staff} title="Every update, on brand." sub="Retailer-branded, automatic customer notifications." />
      <div className="panel">
        <h2>{viewing ? 'Sent message' : 'Branded customer communications'}</h2>
        {viewing ? (
          <>
            <dl className="kv" style={{ marginTop: 12 }}>
              <dt>Subject</dt>
              <dd>{viewing.subject}</dd>
              <dt>To</dt>
              <dd>{viewing.recipient}</dd>
              <dt>Status</dt>
              <dd>
                <MessageBadge status={viewing.status} simulated={viewing.simulated} />
                {viewing.error ? ` ${viewing.error}` : ''}
              </dd>
              <dt>Created</dt>
              <dd>{stamp(viewing.createdAt, tz)}</dd>
            </dl>
            <p>
              <Link href="/emails">← Back to template previews</Link>
            </p>
          </>
        ) : (
          <>
            <p>
              Preview what customers receive at each step. Emails come from <b>{fromHeader(staff.org)}</b>, and replies go to{' '}
              <b>{staff.org.replyToEmail}</b>. {process.env.RESEND_API_KEY ? '' : 'No email provider is configured, so sends are simulated and logged.'}
            </p>
            <nav className="pills" aria-label="Email templates">
              {TEMPLATE_KEYS.map((k) => (
                <Link key={k} href={`/emails?template=${k}`} className={`pill${k === template ? ' selected' : ''}`} scroll={false}>
                  {templateName(k)}
                  {staff.org.emailAutomations[k] === false ? ' (off)' : ''}
                </Link>
              ))}
            </nav>
            <div className="muted">
              <b>Subject:</b> {preview.subject}
            </div>
          </>
        )}
        <iframe
          className="preview-frame"
          title="Email preview"
          sandbox=""
          srcDoc={viewing ? viewing.bodyHtml : preview.html}
        />
      </div>

      <section className="panel">
        <h2>Recent customer emails</h2>
        <div className="tablewrap">
          <table className="compact">
            <thead>
              <tr>
                <th>Email</th>
                <th>Order / Quote</th>
                <th>Recipient</th>
                <th>When</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {log.length ? (
                log.map(({ m, orderNumber, quoteNumber }) => (
                  <tr key={m.id}>
                    <td>
                      <Link href={`/emails?view=${m.id}`}>{templateName(m.templateType)}</Link>
                    </td>
                    <td>
                      {orderNumber ? (
                        <Link href={`/orders/${orderNumber}`} scroll={false}>{orderNumber}</Link>
                      ) : quoteNumber ? (
                        <Link href={`/quotes/${quoteNumber}`} scroll={false}>{quoteNumber}</Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{m.recipient}</td>
                    <td>{stamp(m.createdAt, tz)}</td>
                    <td>
                      <MessageBadge status={m.status} simulated={m.simulated} />
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="empty">
                    No emails sent yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
