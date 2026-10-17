ALTER TABLE "tracking_tokens" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tracking_tokens" ADD COLUMN "workshop_job_id" uuid;--> statement-breakpoint
ALTER TABLE "tracking_tokens" ADD CONSTRAINT "tracking_tokens_workshop_job_id_workshop_jobs_id_fk" FOREIGN KEY ("workshop_job_id") REFERENCES "public"."workshop_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_tokens" ADD CONSTRAINT "tracking_tokens_one_target" CHECK (("order_id" IS NULL) <> ("workshop_job_id" IS NULL));
