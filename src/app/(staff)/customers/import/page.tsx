import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/views';
import { hasRole, requireStaff } from '@/lib/auth';
import { ImportForm } from './import-form';

export const metadata: Metadata = { title: 'Import customers' };

export default async function ImportCustomersPage() {
  const staff = await requireStaff();
  return (
    <>
      <PageHeader
        staff={staff}
        title="Import customers."
        sub="Bring your existing customer list into COS in one go."
        actions={
          <Link href="/customers" className="btn">
            ← Customers
          </Link>
        }
      />
      <section className="panel">
        {hasRole(staff, 'manager') ? (
          <>
            <h2>Upload a CSV file</h2>
            <p>
              Export your customers from your till or spreadsheet as a <b>CSV</b> file (in Excel or Numbers: File → Export → CSV). COS recognises columns
              called <b>Name</b> (or <b>First name</b> + <b>Last name</b>), <b>Email</b>, <b>Phone</b>/<b>Mobile</b> and <b>Notes</b> — other columns are
              ignored. You’ll see a preview before anything is saved.
            </p>
            <ImportForm />
          </>
        ) : (
          <div className="notice warn">Only a manager or owner can import customers.</div>
        )}
      </section>
      <section className="panel">
        <h2>How matching works</h2>
        <ul className="muted" style={{ lineHeight: 1.7, marginTop: 0 }}>
          <li>Someone already in COS with the same email (or, if no email, the same phone number) is treated as the same customer.</li>
          <li>For existing customers, only missing details are filled in — nothing already in COS is overwritten.</li>
          <li>Customers without an email can be imported; COS asks for one the first time you place an order for them.</li>
          <li>Up to 10,000 customers per file. The import is recorded in the audit trail.</li>
        </ul>
      </section>
    </>
  );
}
