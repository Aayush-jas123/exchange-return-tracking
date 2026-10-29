# Level-Based Athlete Commission

Commission is no longer one flat rate for every athlete. It is a **step ladder**: a
rate is set on an anchor level and holds on every rung below it until the next
anchor, so a promotion is worth waiting for. Rates are edited in the athlete admin
console, not in code.

## 1. Run the migration

`supabase_migration_level_commission.sql` — Supabase SQL Editor, once:

- adds `comfort_levels.commission_pct NUMERIC(5,2)`;
- seeds the starting ladder only where the column is still empty (safe to re-run);
- keeps the legacy `perks.commission_pct` JSONB in step with the column;
- adds a 0–60 % range check;
- inserts `commission.default_pct = 7` as the fallback for athletes with no level.

Only empty rows, and rows still holding a value an earlier draft of this file wrote,
are seeded — a ladder an operator edited in the admin console keeps its numbers.

| Anchor | Rate | Rungs that earn it |
|---|---|---|
| Comfort Level - 5 (CL5) | 5 % | CL5, CL4 |
| Comfort Level - 3 (CL3) | 10 % | CL3, CL2, CL1 |
| Zero Comfort (ZERO) | 15 % | Zero Comfort |

So the paid ladder reads 5 / 5 / 10 / 10 / 10 / 15 from CL5 up to Zero Comfort: the
rate holds on a rung until the next anchor changes it.

## 2. Configure it in the admin console

`/pages/athlete-admin` → **Configuration → Comfort Levels**.

- One **Commission %** input per level.
- **Save All Changes** writes the ladder along with the other configuration.
- Every level must hold a value between 0 and 60 before the save is accepted.
- The **Level Ladder** section and the athlete drawer both show the rate per athlete.

API: `POST /api/athlete-admin/levels/commission` with
`{ "levels": [{ "id": 1, "commission_pct": 5 }, ...] }`.
`GET /api/athlete-admin/levels` and `GET /api/athlete-admin/config/all` return
`commission_pct` resolved on every level row.

## 3. How a rate is resolved

`services/athlete-program/CommissionService.js` is the only reader:

1. `comfort_levels.commission_pct`
2. `comfort_levels.perks.commission_pct` (where the ladder was first seeded)
3. `program_settings.commission.default_pct`
4. `7`

A rate is frozen onto the order when the order is attributed
(`attributed_orders.commission_rate`), so editing the ladder never rewrites history —
it only changes what future orders pay.

## 4. Where athletes see it

- **Climb tab**: a commission band under the hero shows the current rate, the next
  level's rate and the top-of-ladder rate, with the rupee value of one more level on
  every ₹10,000 of orders. Each ladder rung also lists its own rate.
- **Log tab**: the commission hero states the athlete's current rate and what the next
  level pays.

`GET /api/athlete/:token/climb` returns `commission` (`current_pct`, `next_pct`,
`top_pct`, names and the full per-level ladder).
`GET /api/athlete/:token/commissions` returns `summary.commission_rate`,
`next_rate`, `top_rate` and the level names used by the Log tab.

## 5. Frontend shipping note

The portal template and its assets are served by Shopify, not Render. Upload, in this
order: `shopify-assets/athlete-portal.css` (`?v=13`), `shopify-assets/athlete-portal.js`
(`?v=14`), then `public/page.athlete-portal.liquid`. The migration and Render deploy
are independent of that upload.
