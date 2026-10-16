ALTER TABLE "product_models" ADD COLUMN "clubs_in_set" integer;--> statement-breakpoint
-- Backfill: an iron head's set size is the set make-up priced at no extra cost for it.
UPDATE "product_models" m SET "clubs_in_set" = (c."metadata"->>'clubs')::int
FROM "model_component_rules" r JOIN "components" c ON c."id" = r."component_id"
WHERE r."model_id" = m."id" AND m."category" = 'irons' AND r."upcharge_override_pence" = 0 AND c."metadata" ? 'clubs';
--> statement-breakpoint
-- Shafts imported with a "— +£X per club" note become real per-club upcharges.
UPDATE "components"
SET "name" = regexp_replace("name", ' — \+£[0-9.]+ per club$', ''),
    "value" = regexp_replace("value", ' — \+£[0-9.]+ per club$', ''),
    "upcharge_pence" = ("metadata"->>'perClubUpchargePence')::int,
    "metadata" = ("metadata" - 'perClubUpchargePence') || '{"perClub": true}'::jsonb
WHERE "metadata"->>'perClubUpchargePence' IS NOT NULL;
