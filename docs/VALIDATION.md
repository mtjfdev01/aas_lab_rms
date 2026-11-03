# Executed validation

Validated in the supplied development workspace on **3 November 2026**, using Node.js **24.19.0**, PostgreSQL **17.11**, the restricted `rms_app` runtime role, Vite production build and system Chromium. These results describe the source package and local services, not a published production deployment.

| Check                                       | Actual result                                                                                                                                                                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci` / dependency install from lockfile | Dependencies installed; lockfile included                                                                                                                                                                                                            |
| `npm run check`                             | 21 JavaScript source/test/helper files passed Node syntax checks                                                                                                                                                                                     |
| `npm run format:check`                      | Passed                                                                                                                                                                                                                                               |
| `npm test`                                  | **13 domain tests passed**, no skipped tests                                                                                                                                                                                                         |
| `npm run test:integration`                  | **21 PostgreSQL integration scenarios passed**; Node reports 22 tests including their parent container, zero failed/skipped                                                                                                                          |
| Fresh empty database                        | All six TypeORM migrations applied; demo seeding succeeded; all 21 integration scenarios passed on the fresh database                                                                                                                                |
| Repeat migration and seed                   | Reapplied without destructive reset; existing passwords/records preserved                                                                                                                                                                            |
| `npm run build`                             | React production bundle generated successfully                                                                                                                                                                                                       |
| `npm run test:http`                         | Authentication, branch denial, refresh-token type separation, private media tenant isolation, malformed file rejection, permitted and rejected staff WebSocket subscriptions passed                                                                  |
| `npm run test:browser`                      | Chromium owner login and 13 operational screens; actual mobile QR join, menu selection, order submission and private own-order tracking; responsive staff navigation, per-bill history and fixed/percentage discount controls; no browser exceptions |
| `npm run test:platform`                     | Separate platform login, tenants, scoped audited support read, platform/staff JWT rejection across services, and platform browser sign-in passed                                                                                                     |

The browser checks generated desktop and mobile screenshots under `docs/screenshots`. The integration suite uses real TypeORM transactions and PostgreSQL RLS, not an in-memory mock. Financial race tests issue simultaneous requests and verify one succeeds where two would overallocate or double-bill.

## Integration coverage

1. RLS with missing scope fails closed; an unfiltered query cannot see another tenant.
2. Unassigned branch access and cross-tenant product/related-record injection fail.
3. Manager cannot edit tenant product definitions or other branch overrides.
4. A permanent QR creates distinct customer capabilities without exposing earlier orders; submissions are idempotent.
5. QR/manual rounds share a session, server pricing ignores client totals, taker snapshots stay separate.
6. Kitchen station authorization and item transitions.
7. Concurrent bill finalization cannot allocate an item twice; combined attribution is deduplicated.
8. Split cash/bank collection, pending verification, distinct bill generator/receiver, exactly-once posting and settlement/cleaning.
9. Print jobs/reprints do not create payments; expected drawer closing includes collections once.
10. Concurrent document allocations cannot overpay.
11. Same/cross-branch transfers balance without revenue and reject cross-tenant targets.
12. Posted ledger immutability and persisted event/job retrieval.
13. QR rotation invalidates old permanent links while preserving own-order access.
14. Concurrent bill payments reserve balance once; rejection releases it; refunds are capped; finalized bill snapshots cannot change.
15. Unpaid bill void creates an explicit reversal and blocks later payment.
16. Paid purchase return creates bounded supplier credit/refund without duplicate expense.
17. Subscription suspension blocks staff access and reactivation restores it.
18. Waiter view cannot read customer receipt jobs; GET cannot invoke a financial mutation.
19. PostgreSQL rejects a journal with no balanced posting lines.
20. Only one concurrent refresh-token rotation succeeds; original access token is revoked.
21. Bill timelines preserve discounts and actor snapshots, record all payment/receipt events once, and reject cross-tenant/branch reads and history tampering.

## Not executed here

- Physical 58/80 mm printer output, driver installation or real ESC/POS network transport.
- AWS S3 bucket/IAM/endpoint integration (local storage was exercised).
- Production TLS/reverse proxy, horizontal scaling, hosted deployment, backup restoration or long-running load tests.
- The checked-in GitHub Actions workflow on GitHub itself.

Consult PRODUCTION.md for accounting boundaries, API-first advanced commands and report limits. No claim is made that every original requirement is production-certified or that hardware/infrastructure has been provisioned.
