CREATE TABLE "stock_catalogue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"key" text NOT NULL,
	"sku" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"variant" text DEFAULT '' NOT NULL,
	"brand" text DEFAULT '' NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"cost_pence" integer,
	"price_pence" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"key" text NOT NULL,
	"sku" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"variant" text DEFAULT '' NOT NULL,
	"brand" text DEFAULT '' NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"quantity" integer NOT NULL,
	"cost_pence" integer,
	"price_pence" integer
);
--> statement-breakpoint
CREATE TABLE "stock_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"taken_on" date NOT NULL,
	"file_name" text NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"lines" integer DEFAULT 0 NOT NULL,
	"unmatched" integer DEFAULT 0 NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "stock_catalogue" ADD CONSTRAINT "stock_catalogue_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_snapshot_id_stock_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."stock_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_snapshots" ADD CONSTRAINT "stock_snapshots_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_snapshots" ADD CONSTRAINT "stock_snapshots_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_catalogue_org_key" ON "stock_catalogue" USING btree ("organisation_id","key");--> statement-breakpoint
CREATE INDEX "stock_items_snapshot_idx" ON "stock_items" USING btree ("snapshot_id");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "stock_catalogue", "stock_snapshots", "stock_items" TO cos_app;--> statement-breakpoint
ALTER TABLE "stock_catalogue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "stock_catalogue" USING (organisation_id = cos_current_org()) WITH CHECK (organisation_id = cos_current_org());--> statement-breakpoint
ALTER TABLE "stock_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "stock_snapshots" USING (organisation_id = cos_current_org()) WITH CHECK (organisation_id = cos_current_org());--> statement-breakpoint
ALTER TABLE "stock_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "stock_items" USING (organisation_id = cos_current_org()) WITH CHECK (organisation_id = cos_current_org());
