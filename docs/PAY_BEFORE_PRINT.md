# Pay before print (Shopify invoices)

Ball designs that customers send online (the design page or a promotion link) are paid for before they're printed. The customer never adds them to a basket: staff check the design, then Shopify emails the customer an invoice. **Approving a design never puts it into print on its own.** Print only starts once it's paid, or once staff record that it was paid at the till.

## How it works

1. A customer sends a design, for example through the Titleist No.1 Gift in Golf promotion link. It arrives in COS as a quote marked "To check".
2. On the quote, staff check the logo and proof, then press **Approve and send invoice**.
   - If the same customer sent other designs, tick them to put everything on one invoice. The multi-buy is worked out across all of them, so 1 dozen Pro V1 plus 1 dozen Left Dash comes to £80, not £90.
   - COS creates a Shopify draft order laid out like #D582: the ball product (in dozens), plus a £0 non-physical line such as *Free personalisation: "AB / 1962" (Classic serif, Black ink) – Q-1014*. That line also carries links to the proof and logo images. The order note links back to the job in COS.
   - The customer's name, email and phone go across from COS: COS finds them in Shopify by email, or adds them as a new Shopify customer. COS doesn't store postal addresses, so the customer enters theirs at checkout if they want it posted.
   - **Postage:** the invoice has no postage on it. At checkout the customer picks from your normal rates: *Click & collect – Wheatley Golf Club pro shop, Doncaster (free)*, *Royal Mail Tracked 48* (£4.95) or *Tracked 24* (£5.95), free over £50.
   - The order is tagged `personalised-print`, and its note starts **PRINT BEFORE POSTING – COS Q-…**.
   - Shopify emails the customer the invoice with a payment link.
3. The design now shows **Awaiting payment** and isn't printed. After 3 days unpaid it's flagged in red on the Quotes page and on the promotion page.
4. When the customer pays, Shopify tells COS. COS turns each design into an order **Paid – ready to print**, records the card payment against it, and sends the usual order confirmation. The print job shows the Shopify order number and whether it's **to post** (with the postage option the customer chose) or **collecting**.
5. Print the balls. Then post them from Click & Drop, or hand them over in the shop.

**Other ways a design gets approved, all of which wait for payment:**
- **Quotes list:** these designs show **Check & invoice ▸** instead of the one-click "Approved ✓", which opens the quote.
- **Customer approval link:** if you edit a design and email the proof back, the customer's approve button now reads **Approve and pay securely** and takes them straight to the Shopify payment page. In test mode, they're told a payment link will follow.
- **Paying at the till:** on the quote, open **Mark paid in store / skip invoice**. Enter the name and card or cash. COS records the payment and puts the design into print with no Shopify invoice. If an invoice was already sent, delete that draft order in Shopify so they aren't asked twice.
- **Orders approved before this change** (like COS-1043): the job shows **Not paid yet** with a **Send Shopify invoice** button for what's owed. You've already sent Andy Barnsley's by hand as #D582. COS won't recognise that one when it's paid, so record his payment on COS-1043 as usual.

## Test mode (the default)

Until you switch it on, nothing goes to Shopify or the customer, and **approvals work as they always have**: "Record approval & create order" and "Approved ✓" still put designs straight into print. The pay-before-print rules above only start once `SHOPIFY_INVOICES` is `live`, so the shop isn't stuck while Shopify is being set up. **Approve and send invoice (test mode)** works out the invoice and shows it on the quote: each line, the discount and the exact data that would go to Shopify. The design stays open, so you can send the real invoice later.

## Setting it up

You do these steps yourself in Shopify and Vercel. Never paste keys into chat, emails or files.

### 1. Let COS create draft orders

COS already has a Shopify app: the one behind **Connect to Shopify** on Business → Stock. That app is read-only at the moment. It needs one extra permission.

1. Shopify admin → **Settings → Apps → Develop apps**. This now opens the **Dev Dashboard** (Shopify moved custom apps there in November 2026).
2. Open the COS app → **Configuration** (or **Versions → Create version**) → **Access scopes**. Add `write_draft_orders`, `read_customers` and `write_customers`, and keep the existing ones (`read_products`, `read_inventory`, `read_orders`, `read_all_orders`). The customer permissions let COS find the customer by email, or add them, so their details are filled in on the order.
3. **Release** the new version.
4. In Vercel → COS project → **Settings → Environment Variables**, add `SHOPIFY_EXTRA_SCOPES` = `write_draft_orders,read_customers,write_customers` (Production). Redeploy.
5. In COS → Business → Stock & commitments, press **Reconnect Shopify** and approve. The approval screen should now list draft orders.

*Alternative:* if you already have an Admin API access token with those permissions (it starts `shpat_`), put it in `SHOPIFY_ADMIN_TOKEN` instead and skip steps 4 and 5. Shopify won't issue fixed tokens like this for new apps from 1 December 2026, so the steps above are the better route.

### 2. Tell COS when an invoice is paid (webhook)

1. Shopify admin → **Settings → Notifications → Webhooks** (near the bottom) → **Create webhook**.
   - Event: **Order payment**
   - Format: **JSON**
   - URL: `https://cos.desirablegolf.co.uk/api/webhooks/shopify`
   - Webhook API version: **2026-10**
2. Under the list, Shopify shows "Your webhooks will be signed with …". Copy that key into Vercel as `SHOPIFY_WEBHOOK_SECRET` (Production).
3. If that Webhooks section has gone from your admin, add the same subscription (topic `orders/paid`, same URL) to the COS app in the Dev Dashboard instead. COS then checks it with the app's client secret, which is already in Vercel.

COS checks Shopify's signature on every webhook and ignores anything unsigned, from another store, or without a COS invoice reference.

### 3. Delivery and collection at checkout

Already set up: Shopify offers *Click & collect – Wheatley Golf Club pro shop (free)*, *Royal Mail Tracked 48* and *Tracked 24* (free over £50) on invoice checkouts when the draft has no postage, so COS leaves postage off. When the order is paid, COS reads the customer's choice and shows **to post** (with the service) or **collecting** on the job.

### 4. Royal Mail (Click & Drop)

Nothing new to set up. Paid invoice orders are normal Shopify orders, so they arrive in Click & Drop like your other online orders. **Because Click & Drop imports them as soon as they're paid, before the balls are printed:**

- They're tagged **`personalised-print`** in Shopify. In Shopify's Orders list, filter by that tag to see them all.
- The order note starts **PRINT BEFORE POSTING – COS Q-…**. If your Click & Drop shows order notes or tags, that's how to spot them. I couldn't check Royal Mail's help pages, so look in your Click & Drop import settings for a tag filter. If there is one, you could leave `personalised-print` orders out of the automatic import and add them once they're printed.
- Click & collect orders don't need a label: the COS job says **collecting**.
- Once printed, post as usual. When the tracking is added, Shopify marks the order fulfilled.

### 5. Environment variables (Vercel only)

| Name | Value |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | `desirable-golf-online-store.myshopify.com` |
| `SHOPIFY_EXTRA_SCOPES` | `write_draft_orders,read_customers,write_customers` (step 1) |
| `SHOPIFY_ADMIN_TOKEN` | only if you use the alternative token route |
| `SHOPIFY_WEBHOOK_SECRET` | the signing key from step 2 |
| `SHOPIFY_API_VERSION` | optional, defaults to `2026-10` |
| `SHOPIFY_INVOICES` | leave unset for test mode; set to `live` to send real invoices |

### 6. First live test (before customers)

1. Deploy, with `SHOPIFY_INVOICES` still unset. Try **Approve and send invoice (test mode)** on a real promo design and check the total.
2. Set `SHOPIFY_INVOICES` = `live` and redeploy.
3. Send yourself a design on the promo link (1 dozen Pro V1) using your own email. Approve and send the invoice. Check the email, the £45 total, your name filled in, and that checkout offers Click & collect plus Tracked 48 and 24.
4. In Shopify, open the draft order and choose **Mark as paid** (no card needed). Within a minute the COS job should show **Paid – ready to print** with the Shopify order number and "to post" or "collecting". Check whether it appeared in Click & Drop.
5. Do the same with two designs on one invoice to see £80.
6. Afterwards, cancel or refund the test order in Shopify and delete the test order in COS.

## Good to know

- **Pricing matches what COS showed.** COS sets the promotion discount itself and tells Shopify not to add its automatic "2 dozen for £80" discount on top. One difference: for 3 dozen, COS's multi-buy gives £80 + £45 = **£125**. Shopify's automatic discount (£5 off each, 2 or more) would give £120 in the online shop. If you'd rather COS matched the online shop, that's a small change.
- **Balls not on Shopify** (e.g. Pro V1 Yellow, or any ball whose Shopify price differs from the COS price) go on the invoice as a custom line at the COS price. The quote screen flags this. Shopify stock doesn't go down for those lines.
- **Products are found by handle** (`pro-v1`, `pro-v1x`, `pro-v1x-left-dash`), made from the ball name in COS. If you rename a ball in COS or a product's handle in Shopify, keep them matching.
- Before sending, COS checks Shopify's total matches its own. If not, it deletes the draft and tells you, and nothing reaches the customer.
- If you cancel a draft order in Shopify, COS isn't told. The quote stays "Awaiting payment" until you decline or cancel it in COS.
- Unpaid invoices aren't chased automatically. Use the "Unpaid over 3 days" flag to give the customer a call, or resend the invoice from Shopify.
