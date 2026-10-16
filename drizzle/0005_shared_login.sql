ALTER TABLE "users" ADD COLUMN "login_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "shared_login" boolean DEFAULT false NOT NULL;