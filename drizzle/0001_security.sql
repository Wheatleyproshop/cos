-- COS security hardening: tenant isolation (RLS), least-privilege app role,
-- append-only ledgers and immutable order-origin fields.
--
-- Staff requests run inside a transaction that does
--   SELECT set_config('app.org_id', '<organisation uuid>', true);
--   SET LOCAL ROLE cos_app;
-- so every query is filtered by the policies below at the database level,
-- independently of the application's own organisation_id filters.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cos_app') THEN
    CREATE ROLE cos_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint
GRANT cos_app TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO cos_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION cos_current_org() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;
--> statement-breakpoint

-- ── Least privilege: no DELETE is ever granted to the application role ──────
GRANT SELECT, UPDATE ON organisations TO cos_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON
  users, customers, quotes, orders, messages, attachments, tracking_tokens,
  backup_destinations, backup_runs, brands, product_models, component_categories,
  components, model_component_rules, configuration_quotes, configuration_quote_items
  TO cos_app;
--> statement-breakpoint
-- Ledgers are insert-only for the app role.
GRANT SELECT, INSERT ON audit_events, payments TO cos_app;
--> statement-breakpoint
-- Sessions are only touched by the authentication layer (owner role).
REVOKE ALL ON sessions FROM cos_app;
--> statement-breakpoint

-- ── Row-level security ───────────────────────────────────────────────────────
ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON organisations
  USING (id = cos_current_org()) WITH CHECK (id = cos_current_org());
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'customers', 'quotes', 'orders', 'payments', 'audit_events', 'messages',
    'attachments', 'tracking_tokens', 'backup_destinations', 'backup_runs', 'brands',
    'product_models', 'component_categories', 'components', 'model_component_rules',
    'configuration_quotes', 'configuration_quote_items', 'sessions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organisation_id = cos_current_org()) WITH CHECK (organisation_id = cos_current_org())',
      t
    );
  END LOOP;
END $$;
--> statement-breakpoint

-- ── Append-only ledgers ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION cos_reject_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'COS: % on % is not permitted (append-only / archive instead of delete)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION cos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER payments_append_only
  BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION cos_reject_mutation();
--> statement-breakpoint

-- ── "Order taken by" is permanent ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION cos_protect_order_origin() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.taken_by_user_id IS DISTINCT FROM OLD.taken_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.order_number IS DISTINCT FROM OLD.order_number
    OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id THEN
    RAISE EXCEPTION 'COS: order origin fields (taken_by_user_id, created_at, order_number) are immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION cos_protect_quote_origin() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.quote_number IS DISTINCT FROM OLD.quote_number
    OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id THEN
    RAISE EXCEPTION 'COS: quote origin fields (created_by_user_id, created_at, quote_number) are immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER orders_protect_origin
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION cos_protect_order_origin();
--> statement-breakpoint
CREATE TRIGGER quotes_protect_origin
  BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION cos_protect_quote_origin();
--> statement-breakpoint
CREATE TRIGGER orders_no_delete
  BEFORE DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION cos_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER quotes_no_delete
  BEFORE DELETE ON quotes
  FOR EACH ROW EXECUTE FUNCTION cos_reject_mutation();
