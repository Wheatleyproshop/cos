CREATE TABLE "bank_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"match" text NOT NULL,
	"category" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"account_name" text DEFAULT '' NOT NULL,
	"file_name" text NOT NULL,
	"from_date" date,
	"to_date" date,
	"transaction_count" integer DEFAULT 0 NOT NULL,
	"duplicates_skipped" integer DEFAULT 0 NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bank_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"date" date NOT NULL,
	"description" text NOT NULL,
	"amount_pence" integer NOT NULL,
	"balance_pence" integer,
	"category" text DEFAULT 'Uncategorised' NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pay_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"pay_date" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalised_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payslips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"pay_run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"minutes_worked" integer DEFAULT 0 NOT NULL,
	"hourly_rate_pence" integer DEFAULT 0 NOT NULL,
	"basic_pence" integer DEFAULT 0 NOT NULL,
	"holiday_pay_pence" integer DEFAULT 0 NOT NULL,
	"bonus_pence" integer DEFAULT 0 NOT NULL,
	"tax_pence" integer DEFAULT 0 NOT NULL,
	"employee_ni_pence" integer DEFAULT 0 NOT NULL,
	"pension_pence" integer DEFAULT 0 NOT NULL,
	"other_deductions_pence" integer DEFAULT 0 NOT NULL,
	"employer_ni_pence" integer DEFAULT 0 NOT NULL,
	"employer_pension_pence" integer DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"file_key" text,
	"file_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rota_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"date" date NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "staff_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"job_title" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"personal_email" text DEFAULT '' NOT NULL,
	"start_date" date,
	"end_date" date,
	"pay_type" text DEFAULT 'hourly' NOT NULL,
	"hourly_rate_pence" integer DEFAULT 0 NOT NULL,
	"annual_salary_pence" integer DEFAULT 0 NOT NULL,
	"contracted_minutes_per_week" integer DEFAULT 0 NOT NULL,
	"holiday_tenths_per_year" integer DEFAULT 280 NOT NULL,
	"emergency_name" text DEFAULT '' NOT NULL,
	"emergency_phone" text DEFAULT '' NOT NULL,
	"emergency_relation" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"sensitive_encrypted" text,
	"clock_pin_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"clock_in" timestamp with time zone NOT NULL,
	"clock_out" timestamp with time zone,
	"break_minutes" integer DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'clock' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bank_rules" ADD CONSTRAINT "bank_rules_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_statement_id_bank_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."bank_statements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_pay_run_id_pay_runs_id_fk" FOREIGN KEY ("pay_run_id") REFERENCES "public"."pay_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rota_shifts" ADD CONSTRAINT "rota_shifts_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rota_shifts" ADD CONSTRAINT "rota_shifts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_tx_org_fp_unique" ON "bank_transactions" USING btree ("organisation_id","fingerprint");--> statement-breakpoint
CREATE INDEX "bank_tx_org_date_idx" ON "bank_transactions" USING btree ("organisation_id","date");--> statement-breakpoint
CREATE INDEX "pay_runs_org_idx" ON "pay_runs" USING btree ("organisation_id","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "payslips_run_user_unique" ON "payslips" USING btree ("pay_run_id","user_id");--> statement-breakpoint
CREATE INDEX "rota_org_date_idx" ON "rota_shifts" USING btree ("organisation_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_profiles_user_unique" ON "staff_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "time_entries_user_in_idx" ON "time_entries" USING btree ("user_id","clock_in");--> statement-breakpoint
CREATE INDEX "time_entries_org_in_idx" ON "time_entries" USING btree ("organisation_id","clock_in");--> statement-breakpoint
-- Tenant isolation for the owner's Business area. Staff records and pay are never hard-deleted.
GRANT SELECT, INSERT, UPDATE ON "staff_profiles", "time_entries", "rota_shifts", "pay_runs", "payslips", "bank_statements", "bank_transactions", "bank_rules" TO cos_app;--> statement-breakpoint
GRANT DELETE ON "bank_rules" TO cos_app;--> statement-breakpoint
ALTER TABLE "staff_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "staff_profiles" USING (organisation_id = cos_current_org()) WITH CHECK (organisation_id = cos_current_org());--> statement-breakpoint
ALTER TABLE "time_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "time_entries" USING (organisation_id = cos_current_org()) WITH CHECK (organisation_id = cos_current_org());--> statement-breakpoint
ALTER TABLE "rota_shifts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "rota_shifts" USING (organisation_id = cos_current_org()) WITH CHECK (organisation_id = cos_current_org());--> statement-breakpoint
ALTER TABLE "pay_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "pay_runs" USING (organisation_id = cos_current_org()) WITH CHECK (organisation_id = cos_current_org());--> statement-breakpoint
ALTER TABLE "payslips" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "payslips" USING (organisation_id = cos_current_org()) WITH CHECK (organisation_id = cos_current_org());--> statement-breakpoint
ALTER TABLE "bank_statements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "bank_statements" USING (organisation_id = cos_current_org()) WITH CHECK (organisation_id = cos_current_org());--> statement-breakpoint
ALTER TABLE "bank_transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "bank_transactions" USING (organisation_id = cos_current_org()) WITH CHECK (organisation_id = cos_current_org());--> statement-breakpoint
ALTER TABLE "bank_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "bank_rules" USING (organisation_id = cos_current_org()) WITH CHECK (organisation_id = cos_current_org());
