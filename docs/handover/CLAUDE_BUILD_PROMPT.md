# CLAUDE BUILD PROMPT — COS

Build a production-ready SaaS web application called **COS — Customer Order System** for golf professional shops.

## Visual source of truth
Use `COS_Interactive_Prototype.html` as the visual and interaction reference. Preserve:
- fixed dark-green left navigation
- COS. wordmark
- light neutral workspace
- metric cards
- searchable/filterable order table
- modal-based create/edit/order detail workflow
- restrained, staff-first interface

Do not turn the staff interface into a luxury marketing site. It must be efficient for repeated daily use.

## Core workflow
Quote → Place Order → Ordered → Delayed (when required) → Ready for Collection → Collected.

Support configurable workflows later.

## Order capture
Required fields:
- customer name
- email
- phone
- brand
- product
- SKU/product ID
- full custom specification
- total retail price incl VAT
- deposit received
- outstanding balance (calculated)
- estimated arrival
- internal notes
- supplier order reference
- staff member who took order
- created date/time

The staff member and timestamp are permanent audit data.

## Staff and audit trail
Authentication must identify the logged-in staff member. Every mutation creates an immutable audit event with actor and timestamp:
- order created
- quote created/accepted
- status changed
- ETA changed
- supplier reference changed
- specification changed
- deposit/payment recorded
- note added
- email queued/sent/delivered/failed
- order marked ready
- order collected

## Customer communication
Use Resend. Retailers configure store name, reply-to email and collection location. Customer emails should look like they come from the golf shop, not COS.

Automations:
1. Order confirmation
2. Quote approval
3. ETA changed/delayed
4. Ready for collection
5. Optional reminder if ready but uncollected

Log delivery state against the order.

## Quotes
Quotes use the same specification structure as orders.
Customer can approve through a secure tokenized link without an account.
Approval records date/time and converts the quote into an order without re-keying data.

## Payments
Track deposit and subsequent payments separately.
Show total, paid, balance.
Payment entries must have amount, method, staff member and timestamp.
Do not implement payment processing unless explicitly added later.

## Search / operational dashboard
Dashboard should surface:
- active orders
- awaiting supplier
- delayed/overdue
- ready to collect
- open quotes
- orders requiring attention

Global search: customer, email, phone, order ID, brand, product, SKU, supplier reference.

## Customer records
Customer page shows contact details, active orders, historical orders, quotes, total spend and saved/custom build specifications where appropriate.

## Attachments
Allow staff to attach supplier confirmations, fitting sheets, screenshots, invoices and product photos to an order.

## Backups
Design backup/export architecture for:
- COS-hosted backup
- Google Drive export
- Dropbox export
These can be tier-dependent SaaS features.

## Multi-tenant SaaS
Every retailer is an organisation/workspace. Strictly isolate organisation data.
Roles: Owner/Admin, Manager, Staff.
Store branding and email settings are per organisation.

## Phase 2 — COS Configure
Design schema so future custom-build configurator can support brand/model/component catalogues:
head/model, loft, set makeup, shaft, flex, length, lie, grip, grip size, wraps, upcharges, lead time, imagery.
Staff builds a specification, sends it for customer approval, and accepted configuration creates an order.

## Production quality
Responsive desktop/tablet/mobile.
Accessible controls.
Validation and useful errors.
No destructive delete for normal staff: archive instead.
Use migrations and seed demo data for Desirable Golf.
Include README and `.env.example`.
