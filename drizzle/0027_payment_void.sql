ALTER TABLE "payments" ADD COLUMN "voids_payment_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_voids_payment_id_payments_id_fk" FOREIGN KEY ("voids_payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_voids_unique" ON "payments" USING btree ("voids_payment_id");