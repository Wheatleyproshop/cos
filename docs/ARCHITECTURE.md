# COS architecture notes

## Stack
Next.js 16 (App Router, server actions), React 19, Drizzle ORM, Postgres (Neon or Supabase in production, PGlite embedded locally and in tests), Resend, and S3‑compatible object storage. Hosting target: Vercel.

## Tenant isolation: two layers
1. **Application:** every staff request resolves the session to a user and organisation (`getStaff`). All data access goes through `withTenant(orgId, fn)`.
2. **Database:** `withTenant` opens a transaction, sets `app.org_id`, and runs `SET LOCAL ROLE cos_app`. Every business table has a row‑level security policy, `organisation_id = cos_current_org()`. So a query that forgets its `WHERE organisation_id = …` still can't read or write another retailer's rows. `cos_app` has **no `DELETE`** privilege on anything, and only `INSERT`/`SELECT` on the ledger and payments.

The owner connection (`systemDb()`) bypasses RLS. It is used only to authenticate sessions, resolve customer tokens to a tenant, process webhooks and run cron. Each of those then switches into `withTenant` for the actual work.

`tests/core.test.ts` proves isolation: unfiltered reads only return the current tenant's rows, cross‑tenant inserts fail, and deletes are refused.

## Audit: the COS Ledger
- `audit_events` generalises the recommended `order_events` table, so quotes, customers, settings, users and backups share one ledger. It has `order_id`, `quote_id` and `customer_id` columns for timelines, plus `entity_type`/`entity_id`.
- Actor types are `user`, `system` (COS itself, for example email delivery or the nightly reminder) and `customer` (online quote approval). `actor_label` snapshots the name, so history reads correctly even after a rename.
- Triggers make `audit_events` and `payments` append‑only for **every** role. A separate trigger makes `orders.taken_by_user_id`, `created_at` and `order_number` immutable, and the same for quote origin fields.
- Notes are stored as `note_added` ledger events rather than in an editable field.

## Money
Stored as integer pence (`*_pence`). Balance = total − Σ(deposits + payments − refunds). It is computed, never stored or edited.

## Email flow
1. Inside the business transaction, `enqueueEmail` renders the template, inserts a `messages` row (`queued`), and logs `email_queued` attributed to the staff member. If the automation is off, or a manager chose to skip it, the row is `suppressed` and `email_suppressed` is logged instead.
2. After commit, `dispatchMessages` sends through Resend. It updates the row to `sent` or `failed` and logs it with the **system** actor. A provider outage never rolls back an order.
3. The Resend webhook (`/api/webhooks/resend`, Svix‑signature verified) moves rows to `delivered`, `bounced` or `failed`.

The sender display name is the retailer's store name, and reply‑to is the retailer's address. Templates contain no COS branding. The rendered HTML is stored on the message, so staff can see exactly what was sent.

## Customer tokens
Approval and tracking links use 256‑bit random tokens. Only SHA‑256 hashes are stored, so a token is shown once: staff generate a fresh one each time they need to share it. Approval tokens are single‑use, rotate when re‑sent, and are cleared on accept, decline or cancel. Tracking tokens expire after 365 days and can be revoked.

## Roles
| Capability | Staff | Manager | Owner/Admin |
|---|:-:|:-:|:-:|
| Create/edit orders and quotes, record payments, notes, attachments | ✓ | ✓ | ✓ |
| Refunds/corrections, skip a customer email, archive/restore, re-open collected | | ✓ | ✓ |
| Store settings, automations, attention rules, team, export, backups | | | ✓ |

## Deviations from the recommended data model (`docs/handover/DATA_MODEL.md`)
- `order_events` became `audit_events` (a superset, described above).
- Money columns are `*_pence` integers.
- Additions:
  - `payments.kind` (deposit, payment or refund)
  - `orders.eta_reason`, `supplier`, `supplier_notes`, `status_changed_at`, `ready_at`, `collected_at`, `last_reminder_at`, `quote_id`
  - `quotes.deposit_required_pence`, `valid_until`, `accepted_name`, `internal_notes`
  - `messages.body_html` and `body_text`, `simulated`, `error`
  - `attachments.category` and `size_bytes`
  - `sessions`, `backup_destinations` and `backup_runs`
  - organisation branding, automation and attention‑threshold settings
- Quote statuses: draft, sent, accepted, declined, expired, cancelled. The table shows open quotes alongside orders with a "Quote" badge, as in the prototype.

## Configurable workflows (future)
`src/lib/status.ts` defines the workflow as data: each step has a key, label, customer label, tone and allowed next steps. A per‑organisation workflow (adding Approved, In production or Dispatched) means storing that structure per org and widening the `orders.status` enum. The UI and transition checks already read from the definition.

## Known follow‑ups before general availability
- Self‑serve sign‑up, invitations by email and password reset by email. Today admins set temporary passwords.
- Direct‑to‑bucket presigned uploads for attachments larger than 4 MB.
- Google Drive and Dropbox OAuth connection flow. The upload adapters exist; see `BACKUPS.md`.
- Billing integration for the plan tiers in `src/lib/plans.ts`.
- Per‑retailer verified sending domains in Resend, if a shop wants mail from its own domain rather than a COS sending domain.
