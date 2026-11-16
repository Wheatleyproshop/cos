CREATE TABLE "team_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"token" text NOT NULL,
	"title" text NOT NULL,
	"team_name" text DEFAULT '' NOT NULL,
	"brand" text NOT NULL,
	"product" text NOT NULL,
	"colour" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"sizes" jsonb NOT NULL,
	"price_pence" integer NOT NULL,
	"name_price_pence" integer DEFAULT 0 NOT NULL,
	"name_placement" text DEFAULT '' NOT NULL,
	"name_max_length" integer DEFAULT 20 NOT NULL,
	"terms" text DEFAULT '' NOT NULL,
	"image_key" text,
	"image_mime" text,
	"closes_on" date,
	"closed_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_orders_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "team_orders" ADD CONSTRAINT "team_orders_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_orders" ADD CONSTRAINT "team_orders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_orders_org_idx" ON "team_orders" USING btree ("organisation_id","created_at");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "team_orders" TO cos_app;--> statement-breakpoint
ALTER TABLE "team_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "team_orders" USING (organisation_id = cos_current_org()) WITH CHECK (organisation_id = cos_current_org());
