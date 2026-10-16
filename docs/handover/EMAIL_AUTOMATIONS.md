# RESEND / EMAIL AUTOMATIONS

## Principle
COS is infrastructure. The customer should see the retailer's identity.

## Templates
### Order confirmation
Trigger: order created / Place Order.
Content: order number, product, customer-visible specification, order total, deposit, balance, ETA.

### Quote approval
Trigger: quote sent.
Content: specification, price, lead time, secure approval button.

### ETA revised
Trigger: ETA changes.
Content: previous ETA, new ETA, optional customer-facing reason.

### Ready for collection
Trigger: status becomes Ready for collection.
Content: product, collection location, opening/contact information, balance due.

### Optional collection reminder
Trigger: order remains Ready beyond configured number of days.

## Logging
Store Resend provider ID and lifecycle state. Add order event for queued/sent/delivered/failed states where available.

## Security
Tracking/approval links must use high-entropy tokens; store hashes rather than raw tokens where practical.
