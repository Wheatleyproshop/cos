CREATE TABLE "shopify_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"quote_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'awaiting_payment' NOT NULL,
	"total_pence" integer NOT NULL,
	"cos_total_pence" integer NOT NULL,
	"draft_order_id" text,
	"draft_order_name" text,
	"invoice_url" text,
	"payload" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"shopify_order_id" text,
	"shopify_order_name" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "shopify_invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "shopify_invoices" ADD CONSTRAINT "shopify_invoices_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_invoices" ADD CONSTRAINT "shopify_invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_invoices" ADD CONSTRAINT "shopify_invoices_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shopify_invoices_org_idx" ON "shopify_invoices" USING btree ("organisation_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_invoices_draft_unique" ON "shopify_invoices" USING btree ("draft_order_id");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "shopify_invoices" TO cos_app;--> statement-breakpoint
ALTER TABLE "shopify_invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "shopify_invoices" USING (organisation_id = cos_current_org()) WITH CHECK (organisation_id = cos_current_org());