# REST API guide

Swagger UI: API server `/docs`; generated OpenAPI JSON: `/docs-json`. All identifiers in these examples mean IDs returned by your own authenticated branch APIs, never demo names. JSON bodies are shown below; the UI uses these same operations.

Staff headers:

```http
Authorization: Bearer <accessToken>
X-Branch-Id: <authorized branch UUID>
Idempotency-Key: <new UUID for each business command; reuse for an identical retry>
Content-Type: application/json
```

`GET /api/me` is allowed before branch selection. Mutations, including tenant-wide configuration, use an authorized branch as their audit context. `tenantId`, `branchId` and actor fields inside JSON bodies never grant access. A branch header is a requested scope, checked against authenticated tenant/assignments. Responses use 400 validation, 401 authentication, 403 permissions/scope, 404 invisible/missing records and 409 conflicts.

Paginated configuration, orders, bills, payments and document collections accept `?page=1&limit=200` (limit 1–500). Lists return arrays. UI tables filter/page the currently loaded batch; API clients can request later batches. Reports cap source documents at 5,000 recent records; use the documented report limitation for large histories.

## Authentication and access

- `POST /api/auth/login`: `{ "email":"owner@demo.test", "password":"..." }` → access/refresh tokens.
- `POST /api/auth/refresh`: `{ "refreshToken":"..." }` → rotated tokens. Refresh uses compare-and-swap versioning; concurrent reuse fails. Token revocation is per user, so rotating a token or logging out revokes that user's older token versions across devices.
- `POST /api/logout`: `{}` → revoke user tokens.
- `POST /api/password`: `{ "oldPassword":"...", "newPassword":"12+ characters" }` → change password and invalidate sessions.
- `GET /api/branches`, `POST /api/branches`: owner-only; body `{ "name":"North", "currency":"PKR", "timezone":"Asia/Karachi", "cutoff":4 }`.
- `GET /api/staff`, `POST /api/staff`, `PATCH /api/staff/:id`: owner-only. Body `{ "name":"Ali", "staffId":"EMP-012", "email":"ali@example.test", "password":"12+ characters", "role":"waiter", "permissions":["orders.take","orders.view"], "branches":["uuid"], "stationIds":[], "active":true }`. Omitted permissions use role defaults. Empty permissions mean none. Password is required for creation and optionally resets a different staff member on update. Existing staff ID cannot change. You cannot change your own access via this endpoint.
- `GET /api/access-options`: owner role defaults, permissions and tenant stations.
- `GET /api/branch-staff`: minimal assigned staff directory for table/shift/reassignment workflows.
- `GET/POST /api/settings`: branch timezone/cutoff, `requirePin`, `requireReference`, `verifyNonCash`, `receiptFooter`. No legal tax rates are implied.

## Configuration resources

`GET/POST /api/resources/:kind`, `PATCH /api/resources/:kind/:id` use `{ "name":"...", "active":true, "data":{...} }`. Update sends the full desired configuration data, not a partial JSON merge. Referenced definitions are deactivated with `active:false`, not deleted.

| Kind          | `data` fields                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| category      | `displayOrder`                                                                                                                                    |
| product       | `price`, `categoryId`, `description`, `available`, `soldOut`, `displayOrder`, `imageId`, `variants`, `modifierGroups`                             |
| override      | `productId`, `price`, `available`, `soldOut`, `stationId` and optional definition overrides                                                       |
| floor         | optional descriptive fields                                                                                                                       |
| hall          | `floorId`                                                                                                                                         |
| station       | optional descriptive fields                                                                                                                       |
| charge        | `mode:fixed/percent`, `value`, `kind:tax/service/other`, `base:items/running`, `sequence`, `inclusive`, `types:[DINE_IN,TAKEAWAY]`, `effectiveAt` |
| supplier      | `phone`, `email`, `address`                                                                                                                       |
| purchase_item | `unit`                                                                                                                                            |
| printer       | `width:58/80`, `destination:bill/kitchen/bar`, `stationId` for preparation printers                                                               |
| schedule      | `userId`, `startsAt`, `endsAt`                                                                                                                    |

Product example:

```json
{
  "name": "Fresh Lime",
  "data": {
    "price": 18000,
    "available": true,
    "variants": [{ "id": "regular", "name": "Regular", "price": 18000 }],
    "modifierGroups": [
      {
        "name": "Ice",
        "min": 1,
        "max": 1,
        "options": [{ "id": "less", "name": "Less ice", "price": 0 }]
      }
    ]
  }
}
```

Owner definitions are tenant-wide. Configure a preparation station through the **branch override**, not a branch-specific ID inside a tenant product definition. `GET /api/menu` resolves effective branch data. Customer projections omit internal routing and financial information.

`POST /api/media` is multipart: one `file` and `public=true/false`. Response includes `id`; put that ID into a product's `imageId` or document's `attachmentId`. Actual JPEG/PNG/WebP only, max 5 MB. `GET /api/media/:id` requires authorized access; `DELETE` retires an unreferenced image and preserves its object for history. Replacement means upload a new asset and update the permitted reference. Public QR menu image URL: `/api/media/public/:id?table=<permanent QR token>&thumb=1`.

## Tables and customer access

- `GET/POST /api/tables`: create `{ "name":"T1", "capacity":4, "hallId":null, "waiterId":null }`.
- `PATCH /api/tables/:id`: table fields plus `state:available/occupied/reserved/cleaning`; state must agree with actual open sessions.
- `POST /api/tables/:id/qr`: `{}` → a **new** public URL, invalidating the previous link. Save/download the generated SVG. For security the server stores only the hash, so it cannot redisplay the previous token; generating another link requires replacing printed copies.
- `POST /api/tables/:id/session`: `{ "pin":"random-session-PIN" }` → open session ID. An existing session is returned unchanged; configure its PIN when opening.
- `POST /api/sessions/:id/transfer`: `{ "tableId":"available target UUID" }`.

Public calls use `X-Customer-Token` as a capability, not staff JWT:

1. `GET /api/public/menu?token=<permanent table token>` → branch/table confirmation and menu only.
2. `POST /api/public/join` with the **permanent** token in the header, body `{ "pin":"..." }` if required → customer capability. Save it privately for the current customer browser.
3. `POST /api/public/orders` with the **customer** capability and body `{ "items":[{"productId":"uuid","quantity":1,"variantId":"regular","modifiers":["less"],"notes":"..."}] }`.
4. `GET /api/public/orders` with that customer capability → own orders only.
5. `POST /api/public/request`: `{ "type":"waiter" }` or `{ "type":"bill" }`.

All public POSTs require an idempotency key and are rate limited. Joining does not reveal existing customer/session history. Expired or unknown capabilities fail. Staff must confirm QR orders even when PIN enforcement is disabled.

## Orders, kitchen and waiter

`POST /api/orders` shares the same `items` input as QR ordering, plus either `tableId`, existing `sessionId`, or `type:"TAKEAWAY"`. Prices/totals/actors supplied by clients are ignored. Manual taker defaults to the authenticated user; QR taker is null with display `Self-order (QR)`.

- `POST /api/orders/:id/confirm`: `{}`; confirms a NEW QR order and routes persisted station print jobs.
- `PATCH /api/items/:id`: `{ "status":"PREPARING" }`, then `READY`, then `SERVED` (dine-in) / `COMPLETED` (takeaway); served dine-in can move to completed.
- `POST /api/orders/:id/cancel`: `{ "reason":"..." }`; billed items require a financial adjustment instead.
- `POST /api/orders/:id/reassign`: `{ "userId":"assigned staff UUID" }`; audits previous and new taker; bill snapshots already finalized stay unchanged.
- `GET /api/requests`, `POST /api/requests/:id`: list/resolve persisted waiter and bill requests.
- `GET /api/events`, `GET /api/audit`: recovery and authorized action history.

Socket.IO connects with `auth:{token:accessToken,branchId:uuid}`. Only authenticated server-authorized branch subscription is supported. Event `refresh` means refetch REST data; clients cannot choose arbitrary room names. Customer tracking polls its own capability endpoint and does not subscribe to staff rooms.

## Billing and finance

- `POST /api/bills`: `{ "sessionId":"uuid", "discount":0, "waivedChargeIds":[], "waiverReason":"required when waiving" }`. All rounds must be confirmed and prepared. All unbilled active items are atomically allocated. Snapshot is immutable; no frontend total is accepted.
- `GET /api/bills`: bills with individual payment receiver information.
- `POST /api/payments`: `{ "billId":"uuid", "accountId":"uuid", "amount":20000, "tendered":25000 }` for cash, or `reference` and optional `paidAt` for non-cash. Use `documentId` instead of `billId` for supplier/expense allocations. Never send both. Non-cash tender/change is rejected.
- `POST /api/payments/:id/verify`: `{}`; posts a pending manual payment. `.../reject`: `{ "reason":"..." }` releases an unverified reservation.
- `POST /api/payments/:id/refund`: `{ "accountId":"uuid", "amount":1000, "reason":"..." }` against an original verified sale payment. Requires refund authority; capped at original less previous refunds.
- `POST /api/bills/:id/void`: `{ "reason":"..." }`; only a finalized bill without verified/pending payments; posts reversal and retains original snapshot/history.
- `GET/POST /api/accounts`: create `{ "name":"Drawer", "type":"cash", "opening":0, "reference":"masked only" }`. Types: cash/bank/wallet/card. Currency comes from branch. Never store card/CVV/financial credentials.
- `GET /api/receiving-accounts`: minimal POS receiving choices, not ledger balances.
- `POST /api/cash`: `{ "accountId":"uuid", "kind":"owner_funding", "amount":50000, "reason":"Capital", "note":"optional" }`. Kinds: owner_funding/owner_withdrawal/misc_receipt/misc_expense. Sales/supplier/expense payments create their own movements.
- `POST /api/transfers`: `{ "fromId":"uuid", "toId":"uuid", "toBranchId":"optional target branch UUID", "amount":50000 }`. Same-tenant, same-currency accounts only; cross-branch requires owner authorization. Card settlement uses transfer; record an actual settlement fee separately as misc_expense, never as a duplicate sale.
- `POST /api/journals/:id/reverse`: `{ "reason":"..." }` for discretionary cash movements only. Other documents use their own adjustment APIs.
- `GET/POST /api/shifts`: open `{ "accountId":"cash drawer UUID", "opening":0 }`. `POST /api/shifts/:id/close`: `{ "actual":20000, "note":"optional" }`; `/handover`: `{ "userId":"uuid" }`; `/review`: `{}`.

## Purchases and expenses

`POST /api/documents` purchase:

```json
{
  "kind": "purchase",
  "supplierId": "uuid",
  "invoice": "INV-123",
  "date": "2026-11-03",
  "lines": [{ "itemId": "catalogue UUID", "quantity": 10, "cost": 15000 }],
  "discount": 0,
  "tax": 0,
  "charges": 0,
  "note": "optional",
  "attachmentId": "optional private media UUID"
}
```

Expense: `{ "kind":"expense", "category":"Utilities", "payee":"Provider", "date":"2026-11-03", "amount":50000, "note":"optional" }`. Recognition does not automatically record payment. Use `/payments` with documentId for each allocation. Pending non-cash allocations are verified in Accounts.

`GET /api/documents` includes verified paid and returned values. `POST /api/documents/:id/return`: `{ "amount":3000, "reason":"..." }`; bounded by original purchase less previous returns. `.../supplier-refund`: `{ "accountId":"uuid", "amount":3000, "reason":"...", "reference":"optional" }`; only against actual supplier credit. Invoice uniqueness is branch/supplier scoped. An erroneous duplicate reference must be resolved as an explicit adjustment; no silent bypass.

## Printing and reports

`GET /api/print-jobs`; `POST /api/print-jobs` with `{ "billId":"uuid" }`; `PATCH /api/print-jobs/:id` with `{ "state":"dispatched" }` or `{ "state":"failed", "error":"..." }`. Dispatch is atomically claimed; repeating dispatch after success fails. A dispatched ambiguous transport failure can be marked failed. `POST /api/print-jobs/:id/reprint` requires `{ "reason":"..." }` and creates a separate job retaining the historical payload. Neither dispatch nor reprint records payment.

`GET /api/reports?date=2026-11-03` uses branch timezone/cutoff for source document timestamps. Top-selling item aggregation is all-time and labeled as such. See accounting/report bounds in ARCHITECTURE.md and PRODUCTION.md.

Platform `/platform-api` is a separate process: `/login`, `/tenants` GET/POST, `/tenants/:id/state` POST, `/tenants/:id/support` POST (requires reason), and `/audit` GET. It accepts platform tokens only. Support reads are explicitly audited and do not create impersonated staff sessions.

## Per-bill history and discount options

`GET /api/bills/:id/history?page=1&limit=50` returns `{billId,total,page,limit,events}` for a bill visible in the authenticated tenant/branch and requiring `bills.generate`. Each event includes its action, original timestamp, authenticated actor and snapshotted name/staff ID, source document ID and details. Creation includes the applied discount and rule; payment collection/verification/rejection/refunds, settlement/voids and receipt dispatch/reprints are recorded in the same database transaction as their action. History is append-only and cannot be changed through the runtime role. Legacy audit data is explicitly marked; missing historical profile names/times are not invented.

Generate a fixed discount bill using `{ "sessionId":"uuid", "discountType":"fixed", "discountValue":2550, "discountReason":"Loyalty offer" }` (PKR 25.50 off). Use `"discountType":"percent", "discountValue":1250` for 12.50%. Values use integer minor units for fixed discounts and basis points for percentage discounts. `discounts.apply` is required for a nonzero discount. Discounts cannot exceed the item subtotal; percentages cannot exceed 100%; rounding is half up. The older `discount` field remains supported as a fixed minor-unit discount; do not send it together with `discountValue`. The UI accepts currency amounts/percentages directly and performs conversion before submission.
