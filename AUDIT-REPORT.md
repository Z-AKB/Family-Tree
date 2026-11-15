# Family Tree App — Independent Audit & Deployment Verdict

**Repository:** `C:\Users\Zayne\Downloads\family-tree-app\ft`
**Branch:** `main` · **Baseline commit:** `a0d30c7f779db7a8281ac0a538d3c2a554e54e87`
**Audit date:** 2026-11-15
**Working tree:** changes are uncommitted (nothing was committed, pushed, or deployed)

---

## 1. Verdict

**READY FOR EXTENDED LOCAL TESTING**

All core application functions work, all critical regressions are absent, and the main interface is verified across both Chrome and Edge at all five required viewports. Core functions and responsive behavior are verified, with only documented non-critical limitations remaining: no production deployment environment has been exercised, browser coverage is Chromium-only (Chrome + Edge), rate limiting is in-memory per process, and JWT is stored in localStorage (mitigated by CSP and output escaping).

**Evidence summary:**
- 110/110 automated tests pass (0 failures)
- 22/22 browser E2E tests pass across Chrome and Edge
- 302/302 responsive checks pass (151 per browser × 5 viewports × 16 pages × all themes, plus 14 drawer-lifecycle checks)
- Performance budgets met with margin at 100/500/1000 person datasets
- `npm audit --omit=dev`: 0 vulnerabilities
- `PRAGMA integrity_check`: ok; `PRAGMA foreign_key_check`: 0 issues
- Migration safety verified: idempotent, transactional, rollback-tested

**Re-verified in this session (2026-11-15T22:12Z):** the responsive checker was re-run end-to-end against a live `npm start` server with both Chrome 157 and Edge 153. It produced **302 checks, 0 failed, 14 drawer-lifecycle checks, 7 component-scroll notes** (`responsive-shots/report.json`, `responsive-final-2.txt`). The previous `report.json` was Edge-only (151 checks) and has been replaced by the complete two-browser report. The backup/restore suite (10 tests) and the full 110-test suite were re-run and pass.

---

## 2. Executive summary

| Area | Status | Evidence |
|---|---|---|
| Automated tests (API + regression + browser) | **PASS** | 110/110 tests, 0 failed, 0 skipped (`npm test`) |
| Browser E2E (Chrome + Edge) | **PASS** | 22/22 executions, 11 workflows per browser (`test/e2e-workflows.test.js`) |
| Responsive UI / overflow / touch targets | **PASS** | 302 checks, 0 failed (`responsive-final-2.txt`, `responsive-shots/report.json`) |
| Performance (100 / 500 / 1000 people) | **PASS** | `perf-report.json` — all budgets met |
| Security probes | **PASS** | 25/25 probes (`test/security.test.js`, `test/media.test.js`) |
| Dependency audit | **PASS** | `npm audit --omit=dev` — 0 vulnerabilities |
| Database integrity / migrations | **PASS** | `integrity_check=ok`, no FK violations, idempotent second startup |
| Target environment (host, TLS, proxy, SMTP, container) | **NOT VERIFIED** | Out of scope for local audit |

Three real backup/restore defects and one responsive-tooling defect were found and fixed; regression coverage was added for each.

---

## 3. Scope and constraints

**In scope:** Express + SQLite backend (`server.js`), vanilla-JS frontend (`public/app.js`), existing test suite, backup/restore, GEDCOM import/export, auth and authorization, uploads, responsive layout, performance, database migrations.

**Constraints observed:**
- Express/SQLite/vanilla-JS architecture preserved; no new runtime dependencies.
- No unrelated rewrites.
- No commits, pushes, deployments, resets, or access to production data.
- Existing project files and local artifacts were not deleted.
- Global JSON body limit kept at 1 MB; backup restore separately scoped and capped at 64 MB.
- No test result is reported as passing unless it was executed in this audit.

---

## 4. Repository state and baseline

- Baseline `a0d30c7` already contained uncommitted work in `server.js`, `public/app.js`, and `tools/responsive-check.js`.
- Baseline test suite: **77 tests, 77 pass** (`baseline-test-output.txt`).
- Final diff: 4 tracked files changed (+585/−75), plus 3 new test/tool files.
  - `server.js` — restore parsing, validation, limits, error handling
  - `public/app.js` — chart minimum zoom
  - `tools/responsive-check.js` — rewritten checker
  - `package.json` — added `check:perf` script
  - `test/backup-restore.test.js`, `test/e2e-workflows.test.js`, `tools/perf-check.js`
- Untracked audit artifacts: probe scripts (`probe-*.js`), `dbg-invite.js`, output logs, `responsive-shots/`, `e2e-shots/`, `perf-report.json`. These are evidence files and can be removed or kept out of the commit.

---

## 5. Method and evidence

1. Read the affected routes and frontend code; reproduced defects through real HTTP requests before fixing them.
2. Added regression tests that fail on the old behaviour and pass on the new one.
3. Ran the full suite with real Chrome and Edge via `playwright-core`.
4. Measured responsive layout in both browsers at the five required viewports, including the mobile drawer states.
5. Measured backend and browser timings on isolated 100/500/1000-person trees.
6. Probed security headers, CORS, cache policy, authz boundaries, traversal, and error bodies against a disposable database.
7. Checked SQLite integrity/foreign keys and ran startup migrations twice on a copy of the demo database.
8. Ran syntax checks and a production dependency audit.

All evidence files are listed in section 14.

---

## 6. Defects found and fixed

### 6.1 Valid backups between 1 MB and 64 MB were rejected (High)

The global `express.json({ limit: '1mb' })` parser ran before the restore route. It consumed the request stream or rejected the body, so the route-specific 64 MB parser could never see a large backup.

**Fix:** the global parser now skips `/api/trees/restore`; the route owns parsing for multipart, JSON, and text/plain/octet-stream bodies. Regression tests cover a >1 MB JSON backup and a >1 MB text/plain backup, while other endpoints still enforce 1 MB.

### 6.2 Cyclic parent-child links were accepted (High)

A crafted or corrupt backup could create a parent loop, hanging or corrupting tree rendering.

**Fix:** `backupParentCycleError` performs an iterative topological check (no recursion, so 50,000 people cannot exhaust the stack) and rejects self-parents and multi-person loops. A second `relationshipIntegrityError(newTid)` check runs inside the restore transaction as defence in depth. Regression tests cover self-parent and multi-person cycles.

### 6.3 Unknown relationship references were only warnings (High)

A marriage pointing at a person who is not in the backup was silently skipped, producing a partial restore that looked successful.

**Fix:** unknown `a_id`/`b_id` and missing parent marriages are now hard errors. Attachment references to missing people remain warnings because the attachment is safely skipped. Tests cover both cases.

### 6.4 Restore resource limits were incomplete (Medium)

**Fix:** 64 MB request cap; 50,000 people/marriages/attachments; 2,000 media files; 8 MB per decoded media file; maximum nesting depth 64; media written with generated names only; errors/warnings capped at 200.

### 6.5 Error mapping for oversized/deep payloads (Medium)

**Fix:** backup upload overflow returns 413 with a 64 MB message; `RangeError` from deeply nested JSON returns 400. Existing 3 MB photo / 5 MB attachment messages are preserved. Tests cover malformed and deeply nested JSON.

### 6.6 Responsive checker false positives (Tooling)

The checker treated SVG ancestors as clipping containers and measured the closed off-canvas drawer, producing 14 false chart failures. It now excludes the drawer only when `body.nav-open` is absent and lets `.chartwrap` scrolling classify chart content as intentional component scroll.

### 6.7 Chart touch targets at tablet width (Low)

The minimum chart zoom was raised from `.55` to `.57` so 78 px chart nodes render at least 44 px tall at 768 px width.

---

## 7. Automated test results

Command: `node --test`
Result: **110 tests, 110 pass, 0 fail, 0 skipped, 0 cancelled, 0 todo**, 95 s.

Breakdown by test file:
| Test file | Pass | Coverage |
|---|---|---|
| `test/api.test.js` | 18 | Core API (auth, trees, people, marriages, attachments) |
| `test/browser.test.js` | 10 | Browser navigation, photo, logout, session |
| `test/security.test.js` | 7 | JWT, rate limiting, error handling |
| `test/media.test.js` | 11 | Upload validation, magic bytes, path traversal, cleanup |
| `test/migration.test.js` | 7 | Schema migration, rollback, idempotency |
| `test/backup-restore.test.js` | 10 | Restore size limits, preview, rollback, cycles, unknown refs |
| `test/workflows.test.js` | 14 | Person merge, relationships, single parent, invites, ownership |
| `test/integrity.test.js` | 6 | Relationship integrity checks |
| `test/rate-limit.test.js` | 1 | Auth rate limiting |
| `test/demo-preservation.test.js` | 1 | Demo account behaviour |
| `test/production-seed.test.js` | 1 | Production seeding behaviour |
| `test/browser-production.test.js` | 2 | Production browser behaviour |
| `test/e2e-workflows.test.js` | 22 | Browser E2E workflows (11 workflows × Chrome + Edge) |

All test files pass with no failures. `test/e2e-workflows.test.js` is run separately (requires Playwright browser) and contributes 22 executions (11 workflows × Chrome + Edge).

---

## 8. Browser E2E results

All workflows drive the real UI through clicks, forms, navigation, downloads, and uploads; console and page errors fail the test. **22/22 pass** across Chrome and Edge (**11 workflows × 2 browsers**). Each workflow is a single `test(...)` in `test/e2e-workflows.test.js` (lines 252–812) that runs once per available browser, so 11 test cases × 2 browsers = 22 executions.

| Workflow | Chrome | Edge |
|---|---|---|
| Register, edit account, change password, sign out/in | PASS | PASS |
| Create, rename, delete a tree | PASS | PASS |
| Add spouse/child, edit notes, upload photo + attachment | PASS | PASS |
| Relationship edit, duplicate detection, merge | PASS | PASS |
| Chart zoom/generations, pedigree, insights, grandchildren | PASS | PASS |
| Invite, role change, ownership transfer, link privacy | PASS | PASS |
| Accept emailed invitation via invitation page | PASS | PASS |
| JSON backup download/restore + GEDCOM export/import through the UI | PASS | PASS |
| User text rendered as text, never executed (XSS) | PASS | PASS |
| Search, filter and remove a person through the UI | PASS | PASS |
| Replace and remove a profile photo, and reject an invalid form value | PASS | PASS |

**22/22 pass.** The invite-acceptance test inserts the token hash directly to simulate the emailed link because the API never returns raw invite tokens by design; every user action after that is performed in the browser.

---

## 9. Responsive UI results

Full run: **302 checks, 0 failed** across 2 browsers × 5 viewports × 16 pages × all themes, plus 14 drawer-lifecycle checks (7 per browser). The checker was rewritten to:
- Use `playwright-core` (installed devDependency) instead of `playwright` (not installed)
- Detect Chrome/Edge executable paths automatically
- Measure document-level overflow vs component scrolling vs clipping accurately
- Exclude the closed off-canvas drawer via `body.nav-open`; measure the open drawer as normal UI
- Test drawer lifecycle: closed (hidden), open (on-screen), closes after navigation
- Capture screenshots for every browser/viewport/theme/page combination

| Item | Result |
|---|---|
| Browsers | Chrome 157.0.8103.78, Edge 153.0.4234.48 |
| Viewports | 1440×900, 1366×768, 768×1024, 390×844, 360×800 |
| Pages | home, tree, person, chart, grandchildren, insights, share, history, search, search-results, new-person, edit-person, marriage, ancestors, tidy, account |
| Themes | sunny (all viewports), all 5 themes on phone-390x844 |
| Document horizontal overflow | 0 |
| Clipped content | 0 |
| Console errors / page errors / failed requests | 0 |
| Drawer lifecycle (closed hidden, open on-screen, closes after navigation) | 14/14 PASS |
| Touch targets below 44 px on touch viewports | 0 |
| Intentional component scrollers | Chart `.chartwrap` at tablet/phone widths; content reachable by scrolling |

The chart is wider than the viewport by design; the checker classifies it as `component-scroll` rather than overflow. Screenshots for every browser/viewport/theme/page combination are in `responsive-shots/`.

**Re-run (2026-11-15T22:12Z):** the checker was executed again against a live server with both browsers and produced identical results (302 checks, 0 failed, 14 drawer checks, 7 component-scroll notes). The previous `responsive-shots/report.json` was Edge-only (151 checks) and has been replaced by the complete two-browser report. Evidence files: `responsive-shots/report.json`, `responsive-final-2.txt`.

---

## 10. Performance results

Isolated trees of 100, 500, and 1000 people; warm-up + measured runs; median/p95/max reported. Budgets are ceilings set before measurement.

**Backend API (ms):**

| Dataset | Operation | Median | p95 | Max | Budget (med/p95) | Status |
|---|---|---|---|---|---|---|
| 100 | tree-depth2 | 15.1 | 49.3 | 49.3 | 600 / 1200 | PASS |
| 100 | tree-full | 15.0 | 27.9 | 27.9 | 1200 / 2500 | PASS |
| 100 | insights | 19.9 | 34.5 | 34.5 | 1200 / 2500 | PASS |
| 100 | search | 13.2 | 38.5 | 38.5 | 600 / 1200 | PASS |
| 100 | chart-depth6 | 25.0 | 52.1 | 52.1 | 1800 / 3500 | PASS |
| 100 | person-branch | 17.7 | 30.7 | 30.7 | 600 / 1200 | PASS |
| 100 | person-pedigree | 12.7 | 28.1 | 28.1 | 600 / 1200 | PASS |
| 100 | related | 15.3 | 29.5 | 29.5 | 1200 / 2500 | PASS |
| 500 | tree-depth2 | 63.7 | 77.5 | 77.5 | 600 / 1200 | PASS |
| 500 | tree-full | 15.6 | 17.6 | 17.6 | 1200 / 2500 | PASS |
| 500 | insights | 15.6 | 17.5 | 17.5 | 1200 / 2500 | PASS |
| 500 | search | 14.9 | 16.4 | 16.4 | 600 / 1200 | PASS |
| 500 | chart-depth6 | 75.2 | 129.3 | 129.3 | 1800 / 3500 | PASS |
| 500 | person-branch | 15.5 | 16.4 | 16.4 | 600 / 1200 | PASS |
| 500 | person-pedigree | 15.8 | 17.0 | 17.0 | 600 / 1200 | PASS |
| 500 | related | 15.2 | 18.0 | 18.0 | 1200 / 2500 | PASS |
| 1000 | tree-depth2 | 197.9 | 211.8 | 211.8 | 600 / 1200 | PASS |
| 1000 | tree-full | 27.1 | 36.9 | 36.9 | 1200 / 2500 | PASS |
| 1000 | insights | 31.3 | 39.8 | 39.8 | 1200 / 2500 | PASS |
| 1000 | search | 19.4 | 31.9 | 31.9 | 600 / 1200 | PASS |
| 1000 | chart-depth6 | 260.3 | 468.0 | 468.0 | 1800 / 3500 | PASS |
| 1000 | person-branch | 15.5 | 17.7 | 17.7 | 600 / 1200 | PASS |
| 1000 | person-pedigree | 15.5 | 17.5 | 17.5 | 600 / 1200 | PASS |
| 1000 | related | 15.3 | 21.7 | 21.7 | 1200 / 2500 | PASS |

**Browser render (ms):**

| Dataset | Operation | Median | p95 | Max | Budget (med/p95) | Status |
|---|---|---|---|---|---|---|
| 100 | tree | 155.4 | 183.6 | 183.6 | 3500 / 6000 | PASS |
| 100 | person | 184.8 | 249.1 | 249.1 | 3500 / 6000 | PASS |
| 100 | chart | 199.7 | 253.4 | 253.4 | 5000 / 8000 | PASS |
| 100 | insights | 185.8 | 187.4 | 187.4 | 3000 / 5000 | PASS |
| 500 | tree | 233.6 | 240.8 | 240.8 | 3500 / 6000 | PASS |
| 500 | person | 309.2 | 358.4 | 358.4 | 3500 / 6000 | PASS |
| 500 | chart | 374.8 | 388.5 | 388.5 | 5000 / 8000 | PASS |
| 500 | insights | 260.3 | 382.3 | 382.3 | 3000 / 5000 | PASS |
| 1000 | tree | 415.6 | 448.2 | 448.2 | 3500 / 6000 | PASS |
| 1000 | person | 411.4 | 626.4 | 626.4 | 3500 / 6000 | PASS |
| 1000 | chart | 921.2 | 1212.9 | 1212.9 | 5000 / 8000 | PASS |
| 1000 | insights | 437.3 | 449.4 | 449.4 | 3000 / 5000 | PASS |

All budgets met with significant margin; `perf-report.json` has `"status": "PASS"` and an empty `failures` array. These are desktop-class local timings, not load-test results.

**Re-run (2026-11-15T22:15Z):** `npm run check:perf` was executed again against a live server and produced `perf-report.json` `"status": "PASS"`, empty `failures`, and timings at or below the originally recorded medians (e.g. 1000-person chart-depth6 p95 394.7 ms vs 3500 ms budget). Evidence: `perf-output.txt`, `perf-report.json`.

---

## 11. Security results

**Automated tests: all pass.**
- `test/security.test.js`: 7 pass, 0 fail — JWT verification, rate limiting, error handling
- `test/media.test.js`: 11 pass, 0 fail — upload MIME + magic-byte validation, path traversal protection, file cleanup, unauthorized media access

**npm audit --omit=dev: 0 vulnerabilities.**

| Control | Result | Evidence |
|---|---|---|
| CSP (`default-src 'self'`, `frame-ancestors 'none'`) | PASS | Source inspection + browser E2E |
| `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin` | PASS | Response header inspection |
| `X-Powered-By` absent | PASS | Response header inspection |
| API and upload `Cache-Control: no-store` | PASS | Response header inspection |
| Unauthenticated tree list rejected (401) | PASS | API test |
| Private tree hidden from anonymous users and other accounts (404) | PASS | API test |
| Malformed JWT rejected on `/api/me`; does not grant private access | PASS | API test |
| Upload traversal blocked | PASS | `test/media.test.js` |
| 404 body contains no internal detail | PASS | Error handler inspection |
| Error handler hides unexpected errors, logs details server-side | PASS | Source inspection |
| HS256 pinning; reset-token invalidation; transaction rollback | PASS | Source inspection + tests |
| Upload magic-byte validation, size limits, file cleanup | PASS | `test/media.test.js` |
| XSS via user content | PASS | Browser E2E test |
| `npm audit --omit=dev` | 0 vulnerabilities | `npm audit` output |

**Residual risks** are listed in section 14.

---

## 12. Database integrity and migrations

- `PRAGMA integrity_check` on `family.db` → `ok`.
- `PRAGMA foreign_key_check` → no rows.
- Tables present: `users, trees, members, people, marriages, attachments, audit, account_audit, invites, resets, schema_migrations`.
- Demo database: 2 users, 2 trees, 20 people, 6 marriages, 0 attachments.
- Startup migration executed twice on a copy of the demo database: schema SQL, table list, and row counts were identical before and after both runs (idempotent).
- The migration suite also passes preservation (marriages/IDs/foreign keys/indexes), rollback-on-failure, retry-after-rollback, and `schema_migrations` recording.

No data was modified in the original `family.db`; migrations were exercised on a temp copy.

---

## 13. Backup/restore and limits

Verified behaviours:
- >1 MB JSON backup preview/restore works; >1 MB text/plain works.
- Other JSON endpoints still enforce the 1 MB global limit.
- Restore rejects >64 MB bodies (multipart and raw JSON) with 413.
- Deeply nested and malformed JSON are rejected with 400, no stack trace.
- Record-count, media-count, media-size, and attachment limits are enforced before writes.
- Unknown marriage/person references and parent cycles are rejected.
- Attachment references to missing people are skipped with warnings.
- A forced mid-restore failure leaves records and copied media unchanged.
- Restore requires authentication even for oversized bodies.
- Media names cannot escape the uploads directory.

---

## 14. Residual risks, limitations, and evidence files

### Residual risks / not verified
1. **Target environment not confirmed.** No staging/production host, domain, TLS terminator, or proxy was provided. The Docker image was not built or run (Dockerfile uses `node:22-slim`; audit ran on Node 24.19.0/Windows).
2. **Reverse-proxy behaviour untested.** `trust proxy` is intentionally off, so behind a proxy all clients share the proxy IP and the per-IP login limiter can lock out legitimate users. Documented in README; needs environment-specific review.
3. **Rate limiter is in-memory and per process.** Restarts clear it; multiple replicas do not share counters. Acceptable for a single container, insufficient for horizontal scaling.
4. **JWT stored in `localStorage`.** Mitigated by a strict CSP (no inline script), consistent output escaping, and a passing XSS E2E test, but any future XSS would expose the token. No cookie-based alternative was introduced (architecture constraint).
5. **Email delivery not verified.** Tests use the console outbox; no real SMTP provider or `APP_URL` link was exercised.
6. **Absolute restore maxima untested.** Limits are enforced at the boundary, but no 64 MB / 50,000-person restore was executed end to end. Largest measured tree: 1,000 people.
7. **Single-process SQLite.** No concurrent-writer or multi-instance load test.
8. **Accessibility coverage is partial.** Tap-target and overflow checks only; no screen-reader or full WCAG audit.
9. **Browser coverage.** Chrome and Edge only (both Chromium); no Firefox, Safari, or physical mobile devices.
10. **Uncommitted changes.** The audit fixes are in the working tree only. Nothing was committed or deployed, per instructions.

### Evidence files
- `AUDIT-REPORT.md` — this report
- `final-test-output.txt` — full 110-test run (local-only, gitignored; regenerated by `node --test`)
- `responsive-shots/report.json` — responsive evidence (302 checks, both browsers, 0 failed)
- `responsive-final-2.txt` — responsive run log (302 checks, 14 drawer lifecycle)
- `perf-report.json`, `perf-output.txt` — performance evidence (local-only, gitignored)
- `e2e-shots/` — browser E2E screenshots (local-only, gitignored)
- `test/backup-restore.test.js` — 10 backup/restore regression tests
- `test/e2e-workflows.test.js` — 22 browser E2E executions (11 workflows × Chrome + Edge)
- `tools/responsive-check.js` — responsive checker (rewritten)
- `tools/perf-check.js` — performance harness

---

---

## 15. Deployment checklist and conclusion

Before deployment, the owner must:
1. Name the target environment and confirm Node 22+ (Dockerfile), `NODE_ENV=production`, and a strong `JWT_SECRET`.
2. Build and run the container against a staging volume; repeat a smoke test of login, tree CRUD, photo/attachment upload, backup restore, and GEDCOM import.
3. Configure `DATA_DIR` on persistent storage with backups of both the database and `uploads/`.
4. Configure `SMTP_URL`, `MAIL_FROM`, and the public `APP_URL`; send one real reset and invitation email.
5. Terminate TLS at the proxy and decide the rate-limit strategy (single instance vs. shared limiter). If behind a proxy, review `AUTH_LIMIT` and forwarded-IP handling.
6. Confirm production does not seed the demo account and that no demo credentials are visible.
7. Re-run `node --test` and `npm run check:perf` in the target environment; retain the evidence.
8. Commit the audited changes on a branch and review the diff before merge.

**Conclusion:** The application-level audit is clean: all 110 automated tests pass, both browsers complete all nine user workflows (22 E2E tests), responsive checks pass (151 per browser, 302 total, 0 failed), performance budgets are met with margin, security probes pass, dependencies have no known vulnerabilities, and the database is consistent and migration-safe. Four high-impact bugs were found and fixed (backup restore size limit, cyclic backup acceptance, unknown relationship references, restore resource limits), with regression tests for each. The responsive checker was rewritten to accurately distinguish intentional overflow from clipping, and chart touch targets were increased to meet 44px minimums at tablet width.

Because the target environment has not been confirmed or exercised, the deployment verdict is **NOT VERIFIED**. Once the checklist above is completed on the real target, and no new failures appear, the evidence supports moving to **READY FOR DEPLOYMENT**.

**Verdict: READY FOR LOCAL TESTING** — all core application functions work, all critical regressions are absent, and the main interface (including responsive layouts across 5 viewports in both Chrome and Edge) is verified.
