# COS PRODUCT SPECIFICATION

## 1. Positioning
COS is the customer order platform for modern golf retail. It removes handwritten notes, disconnected task apps and repeated customer chasing.

## 2. Staff experience
The staff UI is intentionally restrained. The approved direction is the supplied prototype: dark green fixed sidebar, white/neutral content area, compact cards, table-led order management and modals for focused tasks.

## 3. Order lifecycle
Default:
- Quote
- Place order
- Ordered
- Delayed (exception state)
- Ready for collection
- Collected

Future workflows can add Approved, In Production and Dispatched.

## 4. Order record
An order stores customer, contact details, product identity, specification, commercial values, ETA, supplier reference, internal notes, status, assigned/taking staff member and timestamps.

### Order Taken By
When a staff member records an order, COS stores the authenticated staff user plus created_at. This must not change if another staff member later edits the order.

## 5. Audit / COS Ledger
Each event is append-only:
actor, timestamp, action, entity, previous value, new value, metadata.
System-generated actions use actor type `system`.

## 6. Commercials
Store:
- gross order total
- deposit total
- payment transactions
- balance due
Do not treat balance as manually editable; calculate it.

## 7. Supplier management
Store supplier/brand, supplier order reference, supplier ETA and optional supplier notes. Future dashboard can group active orders by supplier.

## 8. Customer notifications
Retailer-branded transactional emails are triggered from order events. Staff can preview and optionally suppress a notification where permissions allow.

## 9. Quote acceptance
Tokenized public page; no customer account required. Show exact specification, price, deposit requirement, estimated lead time and retailer terms. Acceptance writes an immutable acceptance event and creates/converts the order.

## 10. Attention engine
Flag:
- ETA passed and not Ready/Collected
- delayed order
- Ready but not collected after configurable number of days
- quote awaiting response after configurable number of days
- order missing supplier reference after configurable period

## 11. Customer tracking
Secure unguessable token URL. Read-only. Shows retailer branding, product/spec, current status, ETA and relevant timeline. Never expose internal notes, margin/cost or staff-only supplier information.

## 12. Attachments
Order-scoped uploads with file type, uploader, timestamp and visibility (`internal` or `customer-visible`).

## 13. SaaS / tenancy
All business data has organisation_id. Enforce tenant isolation server-side and at database policy level where possible.

## 14. Subscription concept
Trial plus paid tiers primarily based on store/user/email usage and advanced features such as backup/export, enhanced reporting and COS Configure.

## 15. Phase 2 — COS Configure
Seasonal component catalogues per brand. Components need validity rules and optional upcharges. Generate a clean build summary for staff and customer approval.
