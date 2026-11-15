CREATE TABLE "shop_sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"line_id" text NOT NULL,
	"order_id" text NOT NULL,
	"order_name" text DEFAULT '' NOT NULL,
	"sold_on" date NOT NULL,
	"channel" text DEFAULT '' NOT NULL,
	"key" text DEFAULT '' NOT NULL,
	"sku" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"brand" text DEFAULT '' NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_pence" integer NOT NULL,
	"discounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"discount_pence" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "voucher_discounts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "shopify_sync" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shop_sales" ADD CONSTRAINT "shop_sales_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shop_sales_org_line" ON "shop_sales" USING btree ("organisation_id","line_id");--> statement-breakpoint
CREATE INDEX "shop_sales_org_date" ON "shop_sales" USING btree ("organisation_id","sold_on");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "shop_sales" TO cos_app;--> statement-breakpoint
ALTER TABLE "shop_sales" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "shop_sales" USING (organisation_id = cos_current_org()) WITH CHECK (organisation_id = cos_current_org());
