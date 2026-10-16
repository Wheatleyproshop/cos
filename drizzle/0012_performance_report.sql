ALTER TABLE "organisations" ADD COLUMN "performance_report" jsonb DEFAULT '{"enabled":true,"recipients":[]}'::jsonb NOT NULL;--> statement-breakpoint
-- Existing shops start with next month's report rather than one for the month already past.
UPDATE "organisations" SET "performance_report" = jsonb_build_object('enabled', true, 'recipients', '[]'::jsonb, 'lastSentMonth', to_char((now() AT TIME ZONE 'Europe/London') - interval '1 month', 'YYYY-MM'));
