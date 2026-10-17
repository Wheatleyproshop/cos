CREATE TABLE "prebook_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"prebook_id" uuid NOT NULL,
	"product" text NOT NULL,
	"sku" text DEFAULT '' NOT NULL,
	"variant" text DEFAULT '' NOT NULL,
	"quantity" integer NOT NULL,
	"quantity_received" integer DEFAULT 0 NOT NULL,
	"unit_cost_pence" integer DEFAULT 0 NOT NULL,
	"expected_date" date,
	"for_customer" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "prebooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"supplier_account_id" uuid,
	"brand" text NOT NULL,
	"season" text DEFAULT '' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"supplier_reference" text DEFAULT '' NOT NULL,
	"placed_on" date,
	"expected_from" date,
	"expected_to" date,
	"notes" text DEFAULT '' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "supplier_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"brand" text NOT NULL,
	"account_number" text DEFAULT '' NOT NULL,
	"rep_name" text DEFAULT '' NOT NULL,
	"rep_phone" text DEFAULT '' NOT NULL,
	"rep_email" text DEFAULT '' NOT NULL,
	"head_office_phone" text DEFAULT '' NOT NULL,
	"head_office_email" text DEFAULT '' NOT NULL,
	"orders_email" text DEFAULT '' NOT NULL,
	"portal_url" text DEFAULT '' NOT NULL,
	"portal_username" text DEFAULT '' NOT NULL,
	"payment_terms" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "next_prebook_number" integer DEFAULT 1001 NOT NULL;--> statement-breakpoint
ALTER TABLE "prebook_lines" ADD CONSTRAINT "prebook_lines_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prebook_lines" ADD CONSTRAINT "prebook_lines_prebook_id_prebooks_id_fk" FOREIGN KEY ("prebook_id") REFERENCES "public"."prebooks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prebooks" ADD CONSTRAINT "prebooks_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prebooks" ADD CONSTRAINT "prebooks_supplier_account_id_supplier_accounts_id_fk" FOREIGN KEY ("supplier_account_id") REFERENCES "public"."supplier_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prebooks" ADD CONSTRAINT "prebooks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_accounts" ADD CONSTRAINT "supplier_accounts_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prebook_lines_prebook_idx" ON "prebook_lines" USING btree ("prebook_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prebooks_org_ref_idx" ON "prebooks" USING btree ("organisation_id","reference");--> statement-breakpoint
-- Tenant isolation. No DELETE: accounts are deactivated, pre-books archived, lines marked removed.
GRANT SELECT, INSERT, UPDATE ON "supplier_accounts", "prebooks", "prebook_lines" TO cos_app;--> statement-breakpoint
ALTER TABLE "supplier_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "supplier_accounts" USING (organisation_id = cos_current_org()) WITH CHECK (organisation_id = cos_current_org());--> statement-breakpoint
ALTER TABLE "prebooks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "prebooks" USING (organisation_id = cos_current_org()) WITH CHECK (organisation_id = cos_current_org());--> statement-breakpoint
ALTER TABLE "prebook_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "prebook_lines" USING (organisation_id = cos_current_org()) WITH CHECK (organisation_id = cos_current_org());
