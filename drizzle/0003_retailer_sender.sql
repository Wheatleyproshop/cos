ALTER TABLE "organisations" ADD COLUMN "sender_email" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "sender_verified_at" timestamp with time zone;