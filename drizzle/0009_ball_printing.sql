CREATE TABLE "print_balls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"brand" text NOT NULL,
	"name" text NOT NULL,
	"colour" text DEFAULT '#ffffff' NOT NULL,
	"price_per_dozen_pence" integer NOT NULL,
	"min_dozens" integer DEFAULT 1 NOT NULL,
	"lead_time_days" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "ball_setup_fee_pence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "print_balls" ADD CONSTRAINT "print_balls_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Tenant isolation, same as the rest of the catalogue: no DELETE (balls are retired, never removed).
GRANT SELECT, INSERT, UPDATE ON "print_balls" TO cos_app;--> statement-breakpoint
ALTER TABLE "print_balls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "print_balls" USING (organisation_id = cos_current_org()) WITH CHECK (organisation_id = cos_current_org());
