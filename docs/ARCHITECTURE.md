# Architecture, tenant isolation and accounting

## Trust boundaries

Tenant identity is derived from a signed, issuer/audience-checked JWT and a **fresh database lookup** of the active user. Token versions revoke existing tokens on logout, access changes and password changes. Actor fields are derived from that lookup, never request body fields. Staff IDs are immutable after creation and unique within the tenant.

Every business operation uses a TypeORM transaction. Transaction-local `app.tenant` and `app.branch` settings control PostgreSQL row-level security. Missing tenant scope sees no rows. Runtime database roles must be non-owners without superuser/BYPASSRLS privileges. Migration ownership is separate; RLS policies intentionally apply to `rms_app`, while narrowly scoped security-definer lookup functions support login, QR resolution and customer capability lookup. Those functions have fixed search paths and grants; public schema creation is revoked.

Branch IDs are checked against current staff assignments and then resolved under tenant RLS. Owner access means all branches in **their tenant**, not all tenants. Composite tenant/branch foreign keys protect transactional relationships; resource relationships stored in configuration JSON are resolved by kind and authorized scope before writes. Tenant product definitions can only be changed by owners; branch managers edit branch overrides. No frontend-supplied tenant/actor ID selects a business scope.

The application serializes mutations with a **tenant-level PostgreSQL transaction advisory lock**, then uses row locks, uniqueness and idempotency constraints. This deliberately favors financial integrity over maximum write throughput. Multiple application instances use the same database lock. For larger tenants, introduce well-ordered finer locks only after preserving concurrency tests.

Public table links are random 256-bit capabilities stored as SHA-256 hashes. A permanent link exposes only that table's restaurant menu. Joining returns a separate random, 12-hour customer capability; it can read only orders created by that customer. A permanent QR never retrieves a whole bill or another customer's order history. QR orders always need staff confirmation; optionally a staff-opened session PIN is also required. PINs should be random and shared privately. Customer ordering uses the same pricing and item-snapshot service as staff ordering.

Staff sockets authenticate on connection, check branch ownership/assignment and subscription, and join rooms containing **both tenant and branch IDs**. Each invalidation rechecks access and contains no order/customer/financial payload. Clients refetch permission-filtered authoritative data on reconnect. Events and print jobs are persisted in the same transaction as accepted actions. Critical state is recovered from REST, not from socket memory. The periodic refresh also recovers if invalidation delivery fails or another API instance handles a write.

Uploads are decoded with Sharp (actual JPEG/PNG/WebP content), bounded to 5 MB and 25 million pixels, then normalized to WebP and thumbnails. Object keys include tenant/branch UUIDs and random filenames. Tenant-wide menu assets can be public through a valid QR scope; financial images require authenticated branch financial access. Quota checks aggregate all tenant media under the tenant mutation lock. S3 credentials remain on the server. Retirement preserves objects for history instead of deleting historical attachments.

## Data organization

Transactional orders/items, sessions, bills/allocations, payments, accounts, journal entries/lines, shifts, documents, media, events and print jobs use relational tables with scope keys and constraints. Configuration objects (categories, product definitions, variants/modifiers, branch overrides, floors/halls, suppliers, catalogue items, printers and schedules) use typed `resources` rows with structured JSON. Every supported referenced ID is explicitly resolved by its expected type and scope before use. This is a deliberate hybrid configuration model, not a claim that every nested option is an independent normalized table.

TypeORM owns migrations and transaction management. Parameterized SQL is used inside the application repository layer to make RLS, row-locking and immutable posting behavior explicit. `synchronize` is always disabled. Applied migration history is recorded by TypeORM. Financial rollback is backup/forward-migration based, not destructive schema rollback.

## Money and posting

Amounts are safe **integer minor units**; `120000` means PKR 1,200.00. Percentage values use basis points (`1000` means 10%). Each charge rounds half up using integer arithmetic. Order item prices and names/variants/modifiers are snapshotted on acceptance. Bills snapshot distinct order takers, item amounts, rule definitions, calculated charges, discount approval and receipt configuration.

Calculation order: sum accepted active items → subtract authorized discount → sort effective applicable charge rules by sequence → calculate each against discounted items or running total → add only exclusive charges. Inclusive tax reports its extracted portion (`base × rate / (10000 + rate)`) and does not increase the total. Put taxable service charges before a running-base tax; put non-taxable charges after it. No jurisdiction-specific legal rates are seeded. Waivers require discount authority and a recorded reason. Equal rule sequence numbers should be avoided for order-sensitive running charges.

Journal lines use positive debits and negative credits. Every entry balances, with a deferred PostgreSQL balance trigger. Journal entries/lines and audits cannot be edited/deleted. Finalized bill totals/snapshots and verified payment amounts cannot be edited.

- Sale recognition: debit receivable, credit gross billed revenue. This minimal ledger reports gross bill sales; it is **not a complete statutory general ledger with separate tax-payable posting**.
- Verified collection: debit receiving account, credit receivable. Pending manually recorded non-cash amounts reserve the bill balance but do not affect cash/account balances. Rejection releases the reservation.
- Purchase/expense recognition: debit cost expense, credit payable. Basic purchases are expensed on recognition; there is no stock valuation or automatic ingredient consumption.
- Verified supplier/expense payment: debit payable, credit paying account. Returns debit payable/credit cost; already paid returns can create supplier credit and a bounded supplier cash refund.
- Customer refund: debit revenue adjustment, credit paying account. The original finalized bill stays immutable and is not reopened for payment. The refund is separately visible in reports and receipts.
- Unpaid finalized bill void: reverse the original recognition entry, cancel items with a reason and retain allocations/history. Paid bills use refund adjustments.
- Owner funding/withdrawals use equity, not revenue/expense. Miscellaneous movements are deliberately classified. Cash-out notes remain optional.
- Same-branch transfer: debit destination, credit source. Cross-branch transfer: balanced clearing entries in both branches, linked by the same transfer UUID; neither records a sale/expense.

Cash shifts require one active shift per drawer. Opening physical cash must equal posted ledger balance, otherwise record an explicit discrepancy movement first. Closing expected cash is the drawer's current ledger balance, incorporating all sources exactly once; actual count and variance are recorded separately. Handover changes the responsible staff with audit history, while each payment keeps its own receiver. A shift's recorded opening is a count, not a duplicate financial posting.

Sales and collections are distinct. Reports use branch timezone and business-day cutoff. They do not assert a complete profit calculation without inventory/COGS and statutory accounting data.

## Idempotency and lifecycle

Every normal staff mutation requires `Idempotency-Key` and `X-Branch-Id`. Keys are scoped to tenant + actor, with path/body/branch hashes; changed input under the same key fails. Financial allocations include pending reservations; concurrent overpayment or duplicate billing fails atomically. Uploads have separate content/object writes and are not idempotent; an interrupted upload may leave an orphan in object storage if the backend crashes before cleanup, so production needs an orphan cleanup job.

A table session accepts QR and manual rounds until the first finalized bill. **Additional rounds before billing combine into one bill.** After bill finalization, settle it and open a new table session rather than modifying its covered items. This restriction prevents silent additions to finalized bills. Table sessions close only when all active items are billed and all bill balances are settled/voided. Customer tokens never close sessions. Table turnover moves to cleaning, then staff marks it available.

## Per-bill immutable timeline

`bill_history` is a separate append-only, tenant/branch-scoped relation. PostgreSQL triggers capture bill creation/status, payment insertion/status and receipt job creation/dispatch in the business transaction, even if a future service path forgets an explicit audit call. Reasons for voids and reprints are retained from their audit records. Transaction-local `app.actor` comes only from the authenticated server scope; historical actor display fields are copied at event time. Runtime credentials have SELECT only on history; immutable triggers also protect against later changes/deletions. A monotonic event sequence preserves order when multiple events share one transaction timestamp.

The migration imports known legacy bill/payment/print audits and marks the import boundary. Old staff-name snapshots that were never recorded are left unavailable, rather than reconstructed from mutable current profiles. Fixed and percentage discounts are validated on the server and stored, including their basis, rounded amount, reason and approver, within the original immutable bill snapshot and creation history.
