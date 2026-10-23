ALTER TABLE "brands" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_models" ADD COLUMN "removed_at" timestamp with time zone;