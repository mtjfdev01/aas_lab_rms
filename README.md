# AAS Restaurant Management SaaS

JavaScript throughout: React 19 + NestJS 11 + TypeORM migrations + PostgreSQL 17 + Socket.IO. No TypeScript source. This repository is a single integrated application, with customer, staff and platform workflows.

## Run after extracting or uploading

Install **Node.js 24 LTS**, npm, and **Docker Desktop / Docker Engine with Compose v2**. From the project root:

```sh
node scripts/setup.mjs
```

This preserves an existing `.env`, otherwise creates a development-only one, installs the lockfile with `npm ci`, starts PostgreSQL, runs migrations, seeds two isolated restaurant tenants and three branches, and runs unit tests. It does not modify your Git configuration or publish anything.

In two terminals at the project root:

```sh
npm run dev:api
npm run dev:web
```

Open the web server on port **5173**. API runs on **3000**; interactive Swagger is served by the API at **/docs**. These are local development addresses; there is no hosted deployment bundled with this source.

### Development demo credentials

| Role    | First tenant        | Second tenant        |
| ------- | ------------------- | -------------------- |
| Owner   | `owner@demo.test`   | `owner2@demo.test`   |
| Manager | `manager@demo.test` | `manager2@demo.test` |
| Cashier | `cashier@demo.test` | `cashier2@demo.test` |
| Waiter  | `waiter@demo.test`  | `waiter2@demo.test`  |
| Kitchen | `kitchen@demo.test` | `kitchen2@demo.test` |
| Bar     | `bar@demo.test`     | `bar2@demo.test`     |

Default setup script's **development-only password:** `DemoOnly-ChangeMe-2026`. If you set `DEMO_PASSWORD` yourself before seeding, use that value instead. Seeding never resets an existing user's password. Stable staff IDs are tenant-local (`EMP-001`, etc.). The first manager is deliberately assigned only Central Branch; the first owner has Central and North branches. The second tenant's records never appear in the first tenant's workspace.

**Never seed these accounts into production.** The seed script refuses `NODE_ENV=production`. Use platform provisioning for real tenants.

### Manual setup without the helper

1. Copy `.env.example` to `.env`; generate a random `JWT_SECRET` with at least 32 characters and set `DEMO_PASSWORD` to a development-only password of 12+ characters.
2. `npm ci`
3. `docker compose up -d --wait db`
4. `npm run migrate`
5. `npm run seed`
6. `npm test` and `npm run test:integration`
7. Start both development servers as above.

`DATABASE_URL` must use **rms_app**, a non-owner role with no superuser or RLS-bypass privileges. The server checks this at startup and refuses an unsafe database connection. `MIGRATION_DATABASE_URL` is for migration/seed processes only. Production tenant API processes must not receive it.

## Working features

- JWT staff authentication with short access tokens, rotating refresh tokens, token revocation, role permissions, branch and station assignments, stable staff IDs, owner branch/staff administration and basic staff schedules.
- Tenant-owned categories/products; branch-only overrides, preparation station routing, variants/modifier limits, availability, image validation/compression/thumbnails, local storage and an S3 storage adapter.
- Floors, halls, table states, waiter assignment, secure QR regeneration, PIN-backed or staff-confirmed customer ordering, isolated customer sessions, active table sessions, session transfers and audit history.
- Shared manual/QR order pricing; multiple rounds, dine-in/takeaway, notes, distinct order taker snapshots, QR confirmation, station preparation, serving, cancellations and reassignment APIs.
- Kitchen/bar boards, requests, persisted events with authenticated branch invalidations, reconnect refresh and periodic reconciliation.
- Per-bill immutable history timelines, fixed/percentage discounts, finalized bill snapshots, configurable integer tax/charge calculations, discounts/waivers, partial/split payments, cash tender/change, manual non-cash verification/rejection, bounded refunds and unpaid bill void reversals.
- Financial accounts, balanced immutable journals, opening balances, cash in/out with optional notes, atomic same/cross-branch transfers, drawer shifts, handover API, closing variance and manager review.
- Suppliers, supply-item catalogue, purchase invoices/lines, expenses, partial document payments, duplicate invoice prevention, purchase returns, supplier credit refunds.
- Persisted print queue, 58/80 mm browser layouts, reprints with audit attribution, and a local ESC/POS TCP print bridge. Physical printing requires compatible hardware and deployment testing.
- Operational and financial reports, audit API, separate platform tenant/subscription administration and explicitly audited read-only support access.

Read [Architecture and isolation](docs/ARCHITECTURE.md), [API payloads](docs/API.md), [Workflow guide](docs/WORKFLOWS.md), [Printing](docs/PRINTING.md), [Validation](docs/VALIDATION.md) and [Production considerations](docs/PRODUCTION.md).

## Optional platform administration

The platform is a **separate service** with a separate signing secret and privileged database connection. Tenant owners are not platform administrators.

1. In `.env`, set `PLATFORM_JWT_SECRET` to a new random secret different from `JWT_SECRET`; set `PLATFORM_ADMIN_EMAIL` and a unique `PLATFORM_ADMIN_PASSWORD` of 14+ characters. Use `PLATFORM_DATABASE_URL` for a protected provisioning database connection, or the migration URL for development.
2. `npm run platform:bootstrap -w backend`
3. `npm run platform -w backend`
4. Open the development web app with query string `?platform=1`.

The platform listener binds loopback port 3001. The Vite development proxy exposes `/platform-api` locally. In production deploy this service behind a separate restricted HTTPS administrative origin. The supplied public Nginx example blocks platform routes.

## Tests and builds

```sh
npm test                    # 13 domain tests
npm run test:integration     # real PostgreSQL, isolated development database only
npm run build               # React production bundle
node scripts/http-security.mjs # running API; HTTP, uploads, sockets
node scripts/browser-smoke.mjs # running API/web + system Chromium
```

Set `CHROMIUM_PATH` if Chromium is installed elsewhere. Integration/browser tests create clearly named development records. Do not run them against live restaurant data. No test resets or drops a database. Generated screenshots are under `docs/screenshots`.

## Source layout

- `backend/src/main.mjs`: NestJS HTTP entry, Swagger, staff Socket.IO authorization.
- `backend/src/service.mjs`: transactional application operations and authorization.
- `backend/src/domain.mjs`: pricing, money, transitions, roles and pure domain rules.
- `backend/src/database.mjs` and `*.sql`: TypeORM migrations and PostgreSQL RLS/constraints.
- `backend/src/media.mjs`: image handling and storage adapters.
- `backend/src/platform.mjs`: separate platform administration service.
- `frontend/src/main.js`: responsive React staff/customer workspace.
- `frontend/src/platform.js`: platform UI; `api.js`: token/session/API handling.
- `scripts`: setup, print bridge and executable smoke checks.

The ZIP excludes `.env`, dependencies, uploaded customer media, database volumes and Git metadata. After manual upload, run setup to install dependencies and initialize your own database.

## Updating an existing installation

Keep your existing `.env`, database and uploads. Replace application source and run `npm ci`, then `npm run migrate` with the protected migration connection, rebuild the frontend and restart the API. Do not reseed live data. The bill-history migration imports available old audit entries and labels missing historical details; all future bill/payment/receipt transitions are captured transactionally. Open **Billing → History** on any bill. Fixed-amount and percentage discounts are selected when generating a bill; finalized totals remain immutable.
