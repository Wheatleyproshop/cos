# COS — Customer Order System
## Claude / Vercel Build Handover

This package is the working product brief and visual reference for COS, a staff-first customer order management platform for golf professional shops.

### Start here
1. Open `COS_Interactive_Prototype.html` in a browser.
2. Read `CLAUDE_BUILD_PROMPT.md`.
3. Read `PRODUCT_SPEC.md` for detailed behaviour and data requirements.
4. Use `DATA_MODEL.md` when creating the database.
5. Use `EMAIL_AUTOMATIONS.md` when integrating Resend.

### Product principle
COS is operational software for staff. Keep the interface fast, calm and obvious. The dark-green left navigation and current layout are the approved visual direction. Do not redesign it into a marketing website or over-brand the staff UI.

Customer-facing emails and tracking pages should carry the retailer's own branding.

### Suggested production stack
- Next.js / React
- Vercel
- Postgres (Supabase or Neon are sensible options)
- Resend for transactional email
- Secure token-based customer tracking links
- Object storage for attachments
- Scheduled database backups / export integrations

### Critical audit requirement
Every meaningful action must record:
- staff user ID/name
- exact timestamp
- event type
- old value where relevant
- new value where relevant
- automated/system actor where COS performs the action

Do not allow audit events to be silently overwritten.
