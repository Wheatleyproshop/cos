# COS DATA MODEL — RECOMMENDED

## organisations
id, name, slug, store_name, reply_to_email, collection_location, timezone, created_at

## users
id, organisation_id, name, email, role, active, created_at

## customers
id, organisation_id, name, email, phone, created_at, updated_at

## orders
id, organisation_id, order_number, customer_id, status, brand, product, sku,
specification_text, total_gross, eta_date, supplier_reference, internal_notes,
taken_by_user_id, created_at, updated_at, archived_at

## quotes
id, organisation_id, quote_number, customer_id, brand, product, sku,
specification_text, total_gross, estimated_lead_time, status, token_hash,
created_by_user_id, created_at, accepted_at, converted_order_id

## payments
id, organisation_id, order_id, amount, method, reference, recorded_by_user_id, created_at

## order_events
id, organisation_id, order_id, actor_type, actor_user_id, event_type,
old_value_json, new_value_json, metadata_json, created_at

## messages
id, organisation_id, order_id, customer_id, template_type, recipient,
subject, provider_message_id, status, sent_by_user_id, created_at, delivered_at, failed_at

## attachments
id, organisation_id, order_id, storage_key, filename, mime_type, visibility,
uploaded_by_user_id, created_at

## tracking_tokens
id, organisation_id, order_id, token_hash, expires_at, revoked_at, created_at

## future configure tables
brands
product_models
component_categories
components
model_component_rules
configuration_quotes
configuration_quote_items

### Important
`orders.taken_by_user_id` and `orders.created_at` identify who originally took the order.
Subsequent edits do not alter these fields. They create `order_events`.
