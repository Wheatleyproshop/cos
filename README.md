# COS — Customer Order System

Staff-first customer order management for golf professional shops. COS replaces handwritten notes, task apps and customer chasing with one calm workflow:

**Quote → Place order → Ordered → (Delayed) → Ready for collection → Collected**

Built from the COS Claude handover package (`docs/handover/`). The UI follows the approved prototype (`docs/handover/COS_Interactive_Prototype.html`): fixed dark‑green navigation, the COS. wordmark, a neutral workspace, metric cards, a searchable and filterable order table, and modals for create, edit and detail.

## Quick start (local, no external services)

Requires Node.js 20.9+.

```bash
npm install
cp .env.example .env.local      # defaults work as-is for local dev
npm run setup                   # migrate + seed the Desirable Golf demo
npm run dev                     # http://localhost:3000
```

Local development uses **embedded Postgres (PGlite)** stored in `./.data/`. You don't need a database server, Docker or Resend. Emails are rendered, logged and recorded against the order as *sent (simulated)*.

| Demo sign‑in | Role |
|---|---|
| `gary@desirablegolf.test` | Owner / Admin |
| `chris@desirablegolf.test` | Manager |
| `will@desirablegolf.test` | Staff |

Password for all three: `cos-demo-2026`. A second organisation (`alex@fairway.test`) is seeded to demonstrate tenant isolation.

Customer pages from the seed:
- Tracking: `/t/demo-track-james-wilson-cos1048-xxxxxxxx`
- Quote approval: `/q/demo-quote-emily-clarke-q1001-xxxxxxxxxx`

To reset local data, run `rm -rf .data && npm run setup`.

## Scripts

| | |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm test` | Integration tests against an in-memory Postgres (tenant isolation, ledger immutability, lifecycle, quotes, jobs) |
| `npm run typecheck` | TypeScript |
| `npm run db:generate` | Generate a new SQL migration after editing `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations (`drizzle/`) to `DATABASE_URL` |
| `npm run db:seed` | Seed demo data (skips if already present). **Don't run in production.** |

## Deploying to Vercel

1. **Database:** create a Neon or Supabase Postgres database and set `DATABASE_URL` (use the pooled connection string).
2. **Run migrations** from your machine or CI: `DATABASE_URL=... npm run db:migrate`. The security migration creates a `cos_app` role. Your connection role needs `CREATEROLE`, which Neon's and Supabase's default owner roles have.
3. **Environment:** set everything in `.env.example`. You need:
   - `AUTH_SECRET`: generate with `openssl rand -base64 32`.
   - `NEXT_PUBLIC_APP_URL`: your production URL, used in customer email links.
   - `RESEND_API_KEY`, and `EMAIL_FROM_DOMAIN=mail.cosgolf.co.uk` (verified in Resend). Each shop then sends as `"Shop Name" <shop-slug@mail.cosgolf.co.uk>`, with replies going to the shop.
   - `NEXT_PUBLIC_APP_URL=https://cosgolf.co.uk` once the domain is attached in Vercel.
   - `RESEND_WEBHOOK_SECRET`: point a Resend webhook at `/api/webhooks/resend` for the delivered, bounced, failed and complained events.
   - `STORAGE_DRIVER=s3` plus the `S3_*` and `STORAGE_BUCKET` settings. Serverless hosts have no persistent disk, so attachments and backups need S3, R2 or Supabase Storage.
   - `CRON_SECRET`. `vercel.json` schedules `/api/cron/daily` at 07:00 UTC for collection reminders and the nightly backup.
   - Leave `DEMO_MODE` unset.
   - Notifications poll every 20 seconds while COS is open. Push notifications while COS is fully closed need Web Push (VAPID keys plus a push sender); the service worker already handles `push` events.
4. **Create the first retailer.** There is no public sign‑up yet. Insert an organisation and an admin user, for example by adapting `src/db/seed.ts`. After that, the admin adds staff under **Store settings → Team**.

## What's included

- **Orders:** every required capture field. "Order taken by" is the signed‑in user and the timestamp. Both are permanent and enforced by a DB trigger. You also get the status workflow, ETA revisions with a customer‑facing reason, supplier reference and notes, archive and restore (managers and admins), and a "Reorder this build" action.
- **Quotes:** same specification structure as orders. The customer approves through a secure, single‑use tokenised link with no account needed. Staff can also record an in‑store approval. Approval stores an immutable snapshot of exactly what was accepted, then converts the quote into an order without re‑keying.
- **Payments:** deposits, payments and refunds are separate append‑only entries, each with an amount, method, reference, staff member and timestamp. Total, paid and balance are always calculated, never typed in. Refunds are manager‑only. Collecting an order with a balance outstanding needs an explicit confirmation.
- **COS Ledger (audit):** every mutation writes an append‑only event with the actor (user, system or customer), timestamp, old and new values, and metadata. Postgres triggers reject `UPDATE`/`DELETE` on the ledger and payments, even for the owner role.
- **Sending from the shop's own address:** in **Store settings**, an admin can set *Send customer emails from*, for example `orders@desirablegolf.co.uk`. COS checks with Resend that the domain is verified and switches over only once it is; until then it uses the cosgolf.co.uk address.
- **Customer emails (Resend):** order confirmation, quote approval, ETA changed or delayed, ready for collection, and a daily collection reminder. Emails are sent as the shop (`"Desirable Golf" <EMAIL_FROM>`, reply‑to the shop) and logged per order through queued, sent, delivered and failed states. Admins can switch each automation on or off. Managers can skip an individual notification, and the skip is recorded.
- **Attention engine:** flags passed ETAs, delayed orders, orders ready but uncollected after N days, quotes awaiting a response after N days, and orders missing a supplier reference after N days. Thresholds are set per store.
- **Dashboard and search:** active orders, awaiting supplier, delayed or overdue, ready to collect, open quotes and needs attention. Global search covers customer, email, phone (digits‑insensitive), order ID, brand, product, SKU and supplier reference.
- **Customers:** contact details, active and historical orders, quotes, lifetime value, total paid and saved builds.
- **Attachments:** supplier confirmations, fitting sheets, invoices, screenshots and photos. Each records its type, uploader, timestamp and visibility (`internal` or `customer-visible`). Files are served only after an authorisation check.
- **Customer tracking page:** read‑only, retailer‑branded and token‑secured. It never shows internal notes, staff names or supplier details.
- **Multi‑tenant SaaS:** organisations with Owner/Admin, Manager and Staff roles. Branding and email settings are per organisation. Data is isolated in the app layer *and* by Postgres row‑level security.
- **Backups and export:** JSON export of everything and CSV export of orders (admin), a COS‑hosted nightly backup, and a Google Drive and Dropbox adapter design. Plan tiers gate these features.
- **Custom Fitting (COS Configure):** a step‑by‑step builder (Brand → Head → Shaft → Grip → Ball → Summary) with a live build summary and RRP total. Validity rules stop invalid combinations, such as wood shafts on irons. "Save fitting" creates a draft quote. "Create quote" emails the customer an approval link, and the structured build is carried through to the order. The **Products** page manages brands, heads and components with upcharges and lead times; items are retired, never deleted. See `docs/CONFIGURE.md`.
- **App icon and install:** COS installs as an app. On a Mac, use Safari's *File → Add to Dock* or Chrome/Edge's *Install COS*. On iPhone or iPad, use *Share → Add to Home Screen*. Icons, manifest and service worker are linked only from staff pages, so customer pages never show COS branding.
- **Notifications:** a bell with a live feed of new orders, quote approvals, ready‑for‑collection updates, email delivery failures and backup failures. The feed comes from the ledger and excludes your own actions. Choose *Turn on desktop alerts* to get system notifications on the Mac, and on iPhone once COS is added to the Home Screen.

See `docs/ARCHITECTURE.md` for design decisions and `docs/BACKUPS.md` for the backup design.

## Project layout

```
drizzle/                 SQL migrations (0001_security.sql = RLS, roles, append-only triggers)
scripts/                 migrate / seed CLIs
src/db/                  schema, client (PGlite or Postgres), seed
src/lib/services/        business logic: orders, quotes, admin, backups, jobs, public
src/lib/email/           branded templates + outbox (Resend)
src/lib/                 auth, audit ledger, attention engine, plans, storage, validation
src/app/(staff)/         staff UI pages + server actions
src/app/@modal/          intercepting routes that open orders/quotes as modals
src/app/q, src/app/t     customer quote-approval and tracking pages
src/app/api/             attachments, export, cron, Resend webhook
tests/                   integration tests
```
