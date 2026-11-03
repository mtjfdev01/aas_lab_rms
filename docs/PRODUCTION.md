# Deployment and actual limits

## Deployment requirements

Build the frontend with `npm ci && npm run build`; serve `frontend/dist` behind an HTTPS reverse proxy. Run `node backend/src/main.mjs` with only the restricted runtime database URL, strong JWT secret, exact `WEB_ORIGIN`, reachable `PUBLIC_WEB_URL` and storage configuration. The supplied Dockerfile builds the backend image. `docs/nginx.conf` is a local reverse-proxy/static-host example; configure TLS with your infrastructure. It blocks the optional platform routes on the public server.

Run migrations as a separate controlled deployment job with the database owner connection. Do not inject `MIGRATION_DATABASE_URL`, `PLATFORM_DATABASE_URL` or platform credentials into tenant API processes. For managed PostgreSQL create a non-owner `rms_app` login before migrations, preserve TLS verification, and use verified database certificate configuration provided by your host. The local Compose passwords are development-only examples, not production secrets. `synchronize:false` is fixed in code.

Run the optional platform service behind a restricted separate administrative HTTPS origin with its own signing key, connection and administrator credentials. The service binds loopback by default. Do not share platform tokens with tenant applications. Back up PostgreSQL and objects together, exercise restoration, and monitor ledger consistency, failed print jobs, expiry, disk quota and migration outcomes. Server logs contain error classes/codes, not secrets or bodies.

For S3 set `STORAGE_DRIVER=s3`, region/bucket/optional compatible endpoint and use an IAM role or AWS backend SDK credentials. Grant access only to the bucket/prefix needed, disable public bucket listing, and keep browser credentials absent. The adapter streams through the authorized backend; it does not expose raw bucket URLs or credentials. Local uploads need a persistent protected volume. Add orphan-object reconciliation and retention policies for crash recovery; asset retirement intentionally preserves historical objects.

The current Socket.IO transport sends only payload-free invalidations; REST/persisted events are authoritative. Periodic reconciliation handles invalidations missed across processes. For immediate distributed fanout and shared rate limits across multiple API instances, configure a tested Socket.IO/Redis adapter and distributed rate limiter before horizontal deployment. Current rate limiting is per process, and writes serialize per tenant for correctness. Benchmark your target restaurant workload before relaxing locks.

## Accounting boundaries

The implemented ledger is balanced and immutable, but is not a complete jurisdiction-compliant accounting package. Gross billed amounts credit revenue together; separate tax-payable accounts and statutory tax reporting need an accounting-specific extension. Purchases are expensed when recognized, not valued as stock; ingredient use/recipes/COGS/inventory are excluded. There is no complete profit report. Supplier credits, owner funding/withdrawals, transfers, sales and actual collections are distinct. Card settlement can be recorded as transfer plus a separately categorized fee movement; no card/gateway credentials are stored.

Named charge calculation is sequenced and uses integer rounding; get local tax configuration reviewed before live use. Inclusive taxes are extracted for display, not added to the total. There is no legal rate default or subscription payment gateway. Customer digital payments are manually recorded and verified, never gateway-confirmed.

## Functional bounds and API-first operations

- Additional order rounds are supported **before the session is finalized for billing**. After finalization, settle and create a new session. Split billing by selected item/person and adding a new round to an already finalized session are not implemented; split/partial **payments** are.
- Configuration uses relational resource rows with JSON nested variants/modifiers and explicit related-record validation. It is not a fully normalized table per option model.
- Histories are paginated at the API. UI filtering/pagination covers the currently loaded batch. Large reports use at most 5,000 recent documents per source; top items are all-time. Add database-side analytical pagination/date aggregation before relying on this dashboard for large historical datasets. Configurable business-day cutoff applies to reporting document timestamps; backdated payment-date reporting and formal period closing need additional accounting reports.
- Password changes, charge waivers, taker reassignment, shift handover and cash reversals have working authorized REST commands; some are API-first without dedicated staff workflow screens. There is no forgotten-password email service or MFA. Refresh revocation is per user rather than per device.
- The seeded demo has multiple roles/tenants/branches and representative menu/orders/purchases/expenses. Demo records, screenshots and tests are not a production dataset. Do not run seed or mutation tests against real restaurant data.
- Basic schedules and marking tables reserved are included. Payroll, biometric attendance, full reservation bookings, recipes and automatic stock deductions are outside scope.
- Public customer tracking uses private-capability polling; authenticated staff use sockets plus polling. Customer capabilities expire after 12 hours; no guest account recovery flow is included.
- Browser and local TCP bridge printing are implemented. Physical printer output, ESC/POS encoding compatibility, USB/Bluetooth transports and installation on your restaurant hardware remain to be verified.
- S3 adapter is implemented but only local storage has been exercised here. S3 IAM, endpoint, bucket lifecycle and production network behavior need deployment validation.
- No hosted website, production database, email/SMS service, subscription payment gateway or financial gateway is provisioned by this code package. No automatic cloud publication was performed.

These are explicit boundaries, not placeholder buttons claiming unimplemented behavior. See VALIDATION.md for commands actually executed and their results.
