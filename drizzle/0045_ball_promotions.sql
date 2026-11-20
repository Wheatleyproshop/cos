CREATE TABLE "ball_promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"token" text NOT NULL,
	"title" text NOT NULL,
	"headline" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"balls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"setup_fee_pence" integer DEFAULT 0 NOT NULL,
	"min_dozens" integer DEFAULT 1 NOT NULL,
	"terms" text DEFAULT '' NOT NULL,
	"closes_on" date,
	"closed_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ball_promotions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "ball_promotions" ADD CONSTRAINT "ball_promotions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ball_promotions" ADD CONSTRAINT "ball_promotions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ball_promotions_org_idx" ON "ball_promotions" USING btree ("organisation_id");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "ball_promotions" TO cos_app;--> statement-breakpoint
ALTER TABLE "ball_promotions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "ball_promotions" USING (organisation_id = cos_current_org()) WITH CHECK (organisation_id = cos_current_org());
