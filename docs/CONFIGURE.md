# COS Configure / Custom Fitting

Goal: staff build a club specification from seasonal brand catalogues, send it for customer approval, and the accepted configuration becomes an order. This reuses the existing quote → order conversion.

## Tables
Built and in use: the Custom Fitting page (`/fitting`) and the Products catalogue (`/products`). Component validity by club type uses `components.metadata.clubCategories`.

- `brands`: per organisation.
- `product_models`: head/model per season, with base price, lead time, image, and a validity window (`valid_from`/`valid_to`).
- `component_categories`: `head`, `loft`, `set_makeup`, `shaft`, `flex`, `length`, `lie`, `grip`, `grip_size`, `wraps`, … with sort order, required flag and multi‑select flag.
- `components`: options within a category (for example *KBS Tour Lite R*), with `upcharge_pence`, lead time, image, season and free‑form `metadata`.
- `model_component_rules`: which components are `allowed`, `excluded` or `default` for a model, with an optional upcharge override and `conditions` JSON for validity rules (for example lie range only with certain set makeups).
- `configuration_quotes` and `configuration_quote_items`: the priced build summary attached to a normal `quotes` row.

## Flow
1. Staff pick a model. The UI loads that model's rules and offers valid components per category, with upcharges and lead time.
2. COS writes a `quotes` row with:
   - `specification_text`: a clean human summary.
   - `specification_json`: the structured build.
   - `total_gross_pence`: the base price plus upcharges.
   - `estimated_lead_time`: the maximum component lead time.
   It also writes the `configuration_quotes`/`items` rows.
3. The existing approval link, acceptance snapshot and conversion copy `specification_json` to the order unchanged.

Plan gating: `hasFeature(org, 'configure')` (Pro).
