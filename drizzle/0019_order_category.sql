ALTER TABLE "orders" ADD COLUMN "category" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "category" text DEFAULT '' NOT NULL;