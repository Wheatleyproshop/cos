# Pay before print (Shopify invoices)

Personalised balls are paid for before they're printed. The customer never adds them to a basket: staff check the design, then Shopify emails the customer an invoice.

## How it works

1. A customer sends a design, for example through the Titleist No.1 Gift in Golf promotion link. It arrives in COS as a quote marked "To check".
2. On the quote, staff check the logo and proof, then press **Approve and send invoice**.
   - If the same customer sent other designs, tick them to put everything on one invoice. The multi-buy is worked out across all of them, so 1 dozen Pro V1 plus 1 dozen Left Dash comes to £80, not £90.
   - COS creates a Shopify draft order: the ball product (in dozens) plus a £0 "Personalisation – free" line. That line carries the COS quote number, the print text or logo name, and links to the proof and logo images. The same details are in the order note.
   - Shopify emails the customer the invoice with a payment link.
3. The quote now shows **Awaiting payment**. After 3 days unpaid it's flagged in red on the Quotes page and on the promotion page.
4. When the customer pays, Shopify tells COS. COS turns each design into an order **Paid – ready to print**, records the card payment against it, and sends the usual order confirmation.

## Test mode (the default)

Until you switch it on, nothing goes to Shopify or the customer. **Approve and send invoice (test mode)** works out the invoice and shows it on the quote: each line, the discount and the exact data that would go to Shopify. The design stays open, so you can send the real invoice later.

## Setting it up

You do these steps yourself in Shopify and Vercel. Never paste keys into chat, emails or files.

### 1. Let COS create draft orders

COS already has a Shopify app: the one behind **Connect to Shopify** on Business → Stock. That app is read-only at the moment. It needs one extra permission.

1. Shopify admin → **Settings → Apps → Develop apps**. This now opens the **Dev Dashboard** (Shopify moved custom apps there in November 2026).
2. Open the COS app → **Configuration** (or **Versions → Create version**) → **Access scopes**. Add `write_draft_orders` and keep the existing ones (`read_products`, `read_inventory`, `read_orders`, `read_all_orders`). `write_customers` isn't needed: Shopify links the invoice to the customer by email.
3. **Release** the new version.
4. In Vercel → COS project → **Settings → Environment Variables**, add `SHOPIFY_EXTRA_SCOPES` = `write_draft_orders` (Production). Redeploy.
5. In COS → Business → Stock & commitments, press **Reconnect Shopify** and approve. The approval screen should now list draft orders.

*Alternative:* if you already have an Admin API access token that includes `write_draft_orders` (it starts `shpat_`), put it in `SHOPIFY_ADMIN_TOKEN` instead and skip steps 4 and 5. Shopify won't issue fixed tokens like this for new apps from 1 December 2026, so the steps above are the better route.

### 2. Tell COS when an invoice is paid (webhook)

1. Shopify admin → **Settings → Notifications → Webhooks** (near the bottom) → **Create webhook**.
   - Event: **Order payment**
   - Format: **JSON**
   - URL: `https://cos.desirablegolf.co.uk/api/webhooks/shopify`
   - Webhook API version: **2026-10**
2. Under the list, Shopify shows "Your webhooks will be signed with …". Copy that key into Vercel as `SHOPIFY_WEBHOOK_SECRET` (Production).
3. If that Webhooks section has gone from your admin, add the same subscription (topic `orders/paid`, same URL) to the COS app in the Dev Dashboard instead. COS then checks it with the app's client secret, which is already in Vercel.

COS checks Shopify's signature on every webhook and ignores anything unsigned, from another store, or without a COS invoice reference.

### 3. Environment variables (Vercel only)

| Name | Value |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | `desirable-golf-online-store.myshopify.com` |
| `SHOPIFY_EXTRA_SCOPES` | `write_draft_orders` (step 1) |
| `SHOPIFY_ADMIN_TOKEN` | only if you use the alternative token route |
| `SHOPIFY_WEBHOOK_SECRET` | the signing key from step 2 |
| `SHOPIFY_API_VERSION` | optional, defaults to `2026-10` |
| `SHOPIFY_INVOICES` | leave unset for test mode; set to `live` to send real invoices |

### 4. First live test (before customers)

1. Deploy, with `SHOPIFY_INVOICES` still unset. Try **Approve and send invoice (test mode)** on a real promo design and check the total.
2. Set `SHOPIFY_INVOICES` = `live` and redeploy.
3. Send yourself a design on the promo link (1 dozen Pro V1) using your own email. Approve and send the invoice. Check the email, the £45 total and the checkout (delivery or collection options).
4. In Shopify, open the draft order and choose **Mark as paid** (no card needed). Within a minute the COS quote should show **Paid – ready to print** with order #… recorded.
5. Do the same with two designs on one invoice to see £80.
6. Afterwards, cancel or refund the test order in Shopify and delete the test order in COS.

## Good to know

- **Pricing matches what COS showed.** COS sets the promotion discount itself and tells Shopify not to add its automatic "2 dozen for £80" discount on top. One difference: for 3 dozen, COS's multi-buy gives £80 + £45 = **£125**. Shopify's automatic discount (£5 off each, 2 or more) would give £120 in the online shop. If you'd rather COS matched the online shop, that's a small change.
- **Balls not on Shopify** (e.g. Pro V1 Yellow, or any ball whose Shopify price differs from the COS price) go on the invoice as a custom line at the COS price. The quote screen flags this. Shopify stock doesn't go down for those lines.
- **Products are found by handle** (`pro-v1`, `pro-v1x`, `pro-v1x-left-dash`), made from the ball name in COS. If you rename a ball in COS or a product's handle in Shopify, keep them matching.
- Before sending, COS checks Shopify's total matches its own. If not, it deletes the draft and tells you, and nothing reaches the customer.
- If you cancel a draft order in Shopify, COS isn't told. The quote stays "Awaiting payment" until you decline or cancel it in COS.
- Unpaid invoices aren't chased automatically. Use the "Unpaid over 3 days" flag to give the customer a call, or resend the invoice from Shopify.
