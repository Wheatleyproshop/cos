CREATE TABLE "sales_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"month" date NOT NULL,
	"months" integer DEFAULT 1 NOT NULL,
	"dimension" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"sales_pence" integer NOT NULL,
	"discount_pence" integer DEFAULT 0 NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"orders" integer DEFAULT 0 NOT NULL,
	"file_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales_history" ADD CONSTRAINT "sales_history_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_history_unique" ON "sales_history" USING btree ("organisation_id","month","months","dimension","name");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "sales_history" TO cos_app;--> statement-breakpoint
ALTER TABLE "sales_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "sales_history" USING (organisation_id = cos_current_org()) WITH CHECK (organisation_id = cos_current_org());
