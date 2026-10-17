CREATE TABLE "workshop_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"club" text NOT NULL,
	"work" text NOT NULL,
	"parts" text DEFAULT '' NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"price_pence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workshop_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" text DEFAULT 'checked_in' NOT NULL,
	"eta_date" date,
	"delay_reason" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"taken_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"collected_at" timestamp with time zone,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "organisations" ALTER COLUMN "email_automations" SET DEFAULT '{"order_confirmation":true,"quote_approval":true,"eta_revised":true,"ready_for_collection":true,"collection_reminder":true,"workshop_checked_in":true,"workshop_delayed":true,"workshop_ready":true}'::jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "workshop_job_id" uuid;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "next_workshop_number" integer DEFAULT 1001 NOT NULL;--> statement-breakpoint
ALTER TABLE "workshop_items" ADD CONSTRAINT "workshop_items_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_items" ADD CONSTRAINT "workshop_items_job_id_workshop_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."workshop_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_jobs" ADD CONSTRAINT "workshop_jobs_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_jobs" ADD CONSTRAINT "workshop_jobs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_jobs" ADD CONSTRAINT "workshop_jobs_taken_by_user_id_users_id_fk" FOREIGN KEY ("taken_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workshop_items_job_idx" ON "workshop_items" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workshop_org_ref_idx" ON "workshop_jobs" USING btree ("organisation_id","reference");--> statement-breakpoint
CREATE INDEX "workshop_customer_idx" ON "workshop_jobs" USING btree ("customer_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workshop_job_id_workshop_jobs_id_fk" FOREIGN KEY ("workshop_job_id") REFERENCES "public"."workshop_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Tenant isolation. No DELETE: jobs are cancelled/archived, items marked removed.
GRANT SELECT, INSERT, UPDATE ON "workshop_jobs", "workshop_items" TO cos_app;--> statement-breakpoint
ALTER TABLE "workshop_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "workshop_jobs" USING (organisation_id = cos_current_org()) WITH CHECK (organisation_id = cos_current_org());--> statement-breakpoint
ALTER TABLE "workshop_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "workshop_items" USING (organisation_id = cos_current_org()) WITH CHECK (organisation_id = cos_current_org());
