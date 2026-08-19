# D1 — LIVE WEBSITE DEMO MODE + POST-RESCUE LIFECYCLE FIX

Continuation of Vindex (keeperhub-hack), after completed M0–M10. Deadline-critical.
Branch: `feature/new-ui`. Do NOT redesign Vindex. Do NOT add Telegram. Do NOT add product scope.
Reuse the proven M3–M10 services.

## Goal

A user must be able to demonstrate the REAL protection lifecycle from the WEBSITE:

PREPARE REAL POSITION → ARM → WATCHING → START PROTECTION DRILL → REAL SIGNALS → CONSENSUS → CONFIRMATION → KEEPERHUB SIMULATION → REAL KEEPERHUB WITHDRAWAL → DESTINATION VERIFICATION → PROTECTED → RESCUE RECEIPT

The resulting withdrawal must be a real Base Sepolia transaction executed through KeeperHub.

## Current State (M10 complete — verified by exploration)

- `demo_runs` table tracks the full run (funding/approval/supply KeeperHub execution ids, policyId, decisionId, evacuationExecutionId, rescueReceiptId, status CREATED→FUNDED→POSITION_CREATED→OBSERVING→CONFIRMED→SIMULATED→EXECUTED→PROTECTED/FAILED).
- `runDemoEndToEnd` (lib/vindex/demo-run.ts, 752 lines) performs the whole flow; returns `M10_ALREADY_COMPLETE` when a PROTECTED run exists for the position. Idempotency keys verbatim: `vindex-m10-<runId>-fund|approve|supply`; `vindex-m7-<executionId>-<paramsHash8>`.
- Post-PROTECTED gap: nothing disarms the policy after PROTECTED; the confirmed decision stays CONFIRMING until expiry; `setup` page hardcodes "Not armed" and its "Arm position" button is permanently disabled; no demo API routes exist; `/demo` page is fully static.
- DB index bug: `demo_runs_active_uniq` is a partial unique index on `(id)` — it does NOT prevent two concurrent active runs for one position (the schema comment says "one active run at a time"). Must become partial unique on `(position_id)` WHERE status not in ('PROTECTED','FAILED') → drizzle generate + migrate.
- Canonical constants: chain 84532 Base Sepolia; USDC underlying `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f`; Aave Pool `0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27`; aUSDC `0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC`; faucet `0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc`; explorer `https://sepolia.basescan.org`. Supply amount 5 USDC = `5000000` base units (`M10_SUPPLY_AMOUNT_BASE`).

## Global Constraints (binding, verbatim from D1 spec)

1. A completed PROTECTED execution must NOT leave the previous policy blocking setup for a future protection session. Historical policy/decision/execution/receipt/audit records must remain immutable — never rewrite historical evidence.
2. After PROTECTED: previous active policy may become DISARMED/COMPLETED as appropriate. `/setup` must distinguish: LAST PROTECTION EVENT: PROTECTED / CURRENT POSITION: none or 0 / CURRENT PROTECTION: NOT ARMED.
3. Demo mode is an explicit operator/demo surface, NOT automatic production behavior. No arbitrary transaction parameters exposed.
4. Demo prepare reuses proven M10 funding/approval/supply logic. New `demo_run` created only if no active run exists. Historical completed demo runs MUST remain untouched.
5. New stable idempotency keys derived from the new demoRunId, verbatim: `vindex-demo-<runId>-fund`, `vindex-demo-<runId>-approve`, `vindex-demo-<runId>-supply` (stage strings: `fund`, `approve`, `supply`).
6. Prepare exactly 5 test USDC (5000000 base units) through: KeeperHub faucet mint → KeeperHub approval → KeeperHub Aave supply. For every write: simulate → persist → broadcast once → recover/poll → independently verify effect. After supply require live aUSDC > 0.
7. If a current nonzero position already belongs to the active run, resume/adopt it; NEVER fund/supply again.
8. Arm flow: safe wallet remains configurable while no policy is armed; Save configuration; Arm position enabled after live validation; user selects STANDARD or DRILL_HIGH_SENSITIVITY; uses existing `/api/vindex/positions/arm` behavior. No new policy semantics. For demo, allow arming STANDARD first so `/monitor` shows the honest baseline.
9. WATCHING baseline: collect fresh M4 observations and evaluate STANDARD using production services. Show `STANDARD / WATCHING / 0/2 or actual matched count`. Do not fabricate WATCHING if current data genuinely differs.
10. Run Protection Drill button: available only when demo position live, config valid, safe wallet configured, no competing execution, demo run belongs to current position. Clicking starts the REAL production flow using existing services (collect fresh signals → arm DRILL_HIGH_SENSITIVITY → evaluate consensus → fresh confirmation → M6 prepare/simulate → M7 execute through KeeperHub → M8 verify destination → Rescue Receipt). DO NOT reimplement decision/execution logic in the UI — the UI/controller only orchestrates existing server services.
11. Live progress shows real persisted stages; poll/read authoritative DB state; refresh/reconnect resumes from persisted state. Never fake animation ahead of backend state.
12. KeeperHub proof: execution ID, status, full/short tx hash, clickable canonical BaseScan URL `https://sepolia.basescan.org/tx/<FULL_HASH>` — href MUST use the full verified hash (66-char 0x hex). Must be the real transaction created by this new demo run.
13. Rescue Receipt: final status PROTECTED, latest Rescue Receipt CTA, expected/withdrawn/verified received, safe wallet, KeeperHub execution ID, transaction link, high-sensitivity drill disclaimer. Never show PROTECTED before destination reconciliation.
14. Failure safety: KeeperHub unavailable / simulation fails / execution unknown / RPC fails / destination verification fails → show existing truthful failure state. Never start another logical withdrawal automatically. A browser refresh must NEVER duplicate funding, supply or evacuation.
15. Demo run history: a new successful demo creates a NEW demoRunId, funding/approval/supply execution IDs, decision, evacuation execution, Rescue Receipt. Do not overwrite previous proof.
16. UI scope: keep existing design (DESIGN.md); only add correct post-PROTECTED messaging, Prepare demo position action, real stage/progress feedback, Run protection drill action, clear proof links. No visual redesign.
17. Automated tests use mocks; zero real writes. No real demo run automatically during implementation.
18. Pre-write gate before real demo buttons are usable: lint, typecheck, unit, e2e, build, db:migrate — all green. (Gates run at end of implementation; the operator runs the ONE live demo manually per handoff.)

## Task 1 — Post-PROTECTED lifecycle settlement (service layer)

Files: `lib/vindex/policy-service.ts`, `lib/vindex/verification-service.ts`, `tests/unit/policy-service.test.ts`, `tests/unit/verification-service.test.ts` (+ new `tests/unit/lifecycle.test.ts` if cleaner).

- Add `settleCompletedProtection(db, positionId)` — idempotent, additive-only: if an armed policy exists → disarm via `disarmPolicy` (isArmed=false, disarmedAt, resolves active ELEVATED/CONFIRMING decision to RESOLVED, audit POLICY_DISARMED); no-op when already clean. Preserves all historical rows; appends only audit events.
- Hook into `verifyEvacuationDestination` success path (verification-service) immediately after the transactional PROTECTED transition + receipt creation: settle the policy lifecycle. Existing idempotent-return path (already VERIFIED) does not re-settle.
- Must not break existing M8/M10 tests: settlement is additive (audit events appended); verify existing assertions still hold, adjust tests only if an assertion enumerated the full audit set.
- Unit tests (mocks only): (a) PROTECTED history does not make current setup claim armed; (b) old armed policy does not block new setup (after settlement, armPolicy arms a fresh policy; PUT config allowed); (c) settle is idempotent; (d) all historical policy/decision/execution/receipt/audit rows preserved; (e) settle runs when a DRILL policy + CONFIRMING decision still exist after PROTECTED.

## Task 2 — demo-run.ts refactor + prepareDemoPosition + runDemoDrill

Files: `lib/vindex/demo-run.ts`, `tests/unit/demo-run.test.ts` (+ `tests/unit/demo-position.test.ts`, `tests/unit/demo-drill.test.ts` if cleaner).

- Refactor fund/approve/supply stage blocks (currently lines ~448–519) into reusable parameterized helpers: idempotency-key factory + audit event prefix as parameters, so M10 (`vindex-m10`, `M10_*` audits) and demo (`vindex-demo`, `DEMO_*` audits) share one implementation. `runDemoEndToEnd` behavior and M10 idempotency keys stay VERBATIM (existing demo-run.test.ts must pass unchanged where it asserts `vindex-m10-<runId>-fund` etc.).
- New `prepareDemoPosition({env, db, ...})`:
  - Resolve active run via `getActiveDemoRun(db, positionId)`. None → preflight (org wallet, safe wallet configured + valid, KeeperHub health, chain via RPC, live aUSDC must be zero → else POSITION_ZERO 409) → insert `demo_runs` status CREATED (with `onConflictDoNothing` re-adopt for race safety once the positionId partial unique index exists) with startingBlockNumber/timestamp + preDemoSafeWalletBalance.
  - If an active run already has a live nonzero position (supplyExecutionId persisted / status POSITION_CREATED+), adopt it — NEVER fund/supply again.
  - Run fund (faucet mint 5000000, key `vindex-demo-<runId>-fund`) → FUNDED; approve (if allowance < 5000000, key `vindex-demo-<runId>-approve`); supply (key `vindex-demo-<runId>-supply`) → POSITION_CREATED. Every write via the proven writeThroughKeeperHub pattern (simulate → persist → broadcast once with stable key → poll to terminal → independent onchain effect verification).
  - After supply require live aUSDC > 0, else run FAILED + truthful error.
  - Return a `DemoRunPrepareView` (runId, status, stage execution ids, tx hashes/links, livePositionAmount).
- New `runDemoDrill({env, db, runId, ...})` — orchestrates ONLY existing services:
  - Guards: run exists, non-terminal, belongs to current position, position live (aUSDC > 0), safe wallet configured, policy state clean, no competing execution (run.decisionId null or its decision has no executed evacuation).
  - Flow: disarmPolicy → armPolicy(DRILL_HIGH_SENSITIVITY) → collectLiveSignalObservations → evaluateProtectionPolicy (require CONFIRMING + readyForSimulation + decisionId, else run FAILED CONSENSUS_FAILED) → prepareEvacuation (readyForExecution required) → executeEvacuation (outcome EXECUTED_VERIFYING_DESTINATION or M7_ALREADY_EXECUTED) → verifyEvacuationDestination (VERIFIED required) → getRescueReceipt → run status PROTECTED with rescueReceiptId + completedAt → settleCompletedProtection (Task 1).
  - Every stage transition persists to demo_runs; resume-safe (persisted execution ids + statuses); errors mark run FAILED with errorCode and rethrow VindexApiError with the truthful message.
  - Reuse `buildProof` for the completion proof.
- Unit tests (mocks, zero real writes): (a) prepare creates a fresh run when no active run exists; (b) completed prepare stage never repeats (fund/approve/supply not re-broadcast on resume); (c) refresh resumes from persisted state; (d) new idempotency keys differ from M10 (`vindex-demo-` prefix, never `vindex-m10-`); (e) one evacuation only (duplicate drill call cannot create a second execution — DB unique + persisted ids); (f) drill calls existing services (assert calls via fakes); (g) PROTECTED only after destination verification (receipt + verified check required); (h) previous receipts remain available; (i) historical completed demo runs untouched by new prepare.

## Task 3 — Demo API routes + authoritative status view

Files: `app/api/vindex/demo/status/route.ts`, `app/api/vindex/demo/prepare/route.ts`, `app/api/vindex/demo/drill/route.ts`, `lib/vindex/demo-controller.ts` (new), `db/schema.ts` (index fix), `drizzle/*` (generated migration), `tests/unit/demo-controller.test.ts` (+ route tests).

- Schema: change `demo_runs_active_uniq` to partial unique index on `(position_id)` WHERE status not in ('PROTECTED','FAILED'). Run `npm run db:generate` and `npm run db:migrate` (NEVER drizzle push).
- `lib/vindex/demo-controller.ts`: server-side in-flight guard (module-level Map keyed by positionId → {kind: "prepare"|"drill"}); async background runners calling Task 2 functions; DB idempotency as backstop.
- `GET /api/vindex/demo/status` → authoritative lifecycle view (read-only except the idempotent self-heal): `{ positionId, activeRun: {runId, status, stageExecutionIds, txHashes, links, decisionId, executionId, receiptId, errorCode} | null, lastProtectionEvent: {status:"PROTECTED", receiptId, executionId, txHash, keeperhubExecutionId, verifiedAmount, safeWallet, completedAt} | null, currentPosition: {exists, positionAmountBaseUnits, underlyingWalletBalance, live, observedAt}, protection: {armed, mode, policyId, armedAt}, progressStage: derived stage string, validation: {readyToPrepare, readyToArm, readyToRunDrill, reasons[]} }`. Self-heal: if lastProtectionEvent is PROTECTED but policy still armed → settle (Task 1) once, so the existing live DB (armed policy from M10) self-corrects on first read.
- `POST /api/vindex/demo/prepare` → guards (env configured, KeeperHub health, safe wallet configured, no in-flight prepare/drill for position) → create/adopt run → background `prepareDemoPosition` → `{ runId, started: true }`.
- `POST /api/vindex/demo/drill` → guards (position live via active run, config valid, safe wallet configured, no in-flight job, no competing execution, run belongs to current position) → background `runDemoDrill` → `{ runId, started: true }`.
- Progress stage derivation (authoritative, from persisted rows): WATCHING → THREAT_EVIDENCE → MATCHED (N/M from decision.matchedCount) → CONFIRMING → SIMULATION_PASSED → KEEPERHUB_SUBMISSION → EXECUTING → TRANSACTION_CONFIRMED → VERIFYING_DESTINATION → PROTECTED. PROTECTED requires a verified receipt row; never derived from execution status alone.
- Route conventions: `runtime = "nodejs"`, `dynamic = "force-dynamic"`, errors via `toApiErrorResponse`.
- Unit tests (mocks): status derivation for every stage; validation flags + reasons; duplicate button click cannot start a second job (in-flight guard) and cannot duplicate execution (DB unique index on positionId; one evacuation per decision); refresh resumes from persisted state; PROTECTED only after M8; tx link uses full hash; no secrets in responses.

## Task 4 — Setup page: correct current-state messaging + working Arm

Files: `components/forms/setup-form.tsx`, `app/(product)/setup/page.tsx`, `tests/e2e/vindex.spec.ts` (new fixtures).

- SetupForm fetches GET `/api/vindex/demo/status` and renders a compact 3-line summary: LAST PROTECTION EVENT: PROTECTED (with link to `/receipt/<id>` when present) / CURRENT POSITION: none or live amount / CURRENT PROTECTION: NOT ARMED or ARMED (mode). Honest: never claim NOT ARMED when a policy is genuinely armed; never claim PROTECTED without a receipt.
- Enable "Arm position" when `validation.readyToArm` (position live, safe wallet configured+valid, not armed). Mode radios (STANDARD / DRILL_HIGH_SENSITIVITY) become functional and POST `/api/vindex/positions/arm` with `{ mode }`. After successful arm show "ARMED — STANDARD, WATCHING" (from arm response).
- Safe wallet remains editable while no policy armed (existing PUT behavior unchanged).
- E2E fixtures (route interception, no real writes): post-PROTECTED setup shows PROTECTED event + position none + NOT ARMED; arm button disabled without live position; arm enabled + successful arm shows ARMED state.

## Task 5 — Demo page: live demo surface

Files: `app/(product)/demo/page.tsx`, `components/dashboard/demo-run-surface.tsx` (new client component), `tests/e2e/vindex.spec.ts` (new fixtures).

- Keep existing demo page design; replace the static walkthrough with a live surface driven by GET `/api/vindex/demo/status` (poll ~3s while a run is active; resume from persisted state on refresh).
- Section 1 — Prepare: "Prepare demo position" button (secondary-button style per DESIGN.md) enabled when `validation.readyToPrepare`; live progress lines Funding / Approval / Aave supply / Position ready, rendered only from persisted stage execution ids + run status. Never re-fund/re-supply.
- Section 2 — Arm: mode radios STANDARD / DRILL_HIGH_SENSITIVITY + "Arm position" (existing `/positions/arm`), plus "Open monitor" link so the honest STANDARD WATCHING baseline is visible (`/monitor` already renders real state incl. matched count from `/api/vindex/decisions/current`).
- Section 3 — Drill: prominent "Run protection drill" button, enabled only when `validation.readyToRunDrill` (reasons rendered when disabled). Live progress rail derived from `progressStage` + persisted rows: WATCHING / THREAT EVIDENCE / N/M MATCHED (actual matchedCount) / CONFIRMING / SIMULATION PASSED / KEEPERHUB SUBMISSION / EXECUTING / TRANSACTION CONFIRMED / VERIFYING DESTINATION / PROTECTED.
- Section 4 — Proof: when execution accepted/completed, KeeperHub execution ID, status, full tx hash, clickable link href `https://sepolia.basescan.org/tx/<FULL_HASH>` (full verified hash from execution.txHash — never a truncated hash, never a fabricated link).
- Section 5 — Rescue Receipt: only after status PROTECTED + receipt exists: CTA to `/receipt/<id>`, expected / withdrawn / verified received amounts, safe wallet, KeeperHub execution ID, transaction link, high-sensitivity drill disclaimer (DRILL_LABEL).
- Failure: run FAILED or errorCode → truthful failure panel (existing failure copy patterns, e.g. Diagnostic-style), never auto-start another withdrawal; refresh never duplicates writes.
- E2E fixtures (interception only): prepare progress states; drill stages; KEEPERHUB proof link uses full hash; PROTECTED only with receipt; failure state rendering; refresh resumes (no duplicate button).

## Task 6 — Full gates + fix wave

Run in order: `npm run lint`, `npm run typecheck`, `npm run test:unit`, `npm run test:e2e`, `npm run build`, `npm run db:migrate`. All green. Fix any failures (resume implementer with findings).

## Final — Whole-branch review + handoff

- One final code review of the full D1 diff (most capable reviewer available).
- I (controller) write the D1 COMPLETION REPORT with: root cause of setup contradiction; lifecycle fix; demo position preparation; website arm flow; STANDARD watching flow; drill orchestration; KeeperHub execution path; destination verification; demo UI/progress; duplicate/recovery safety; tests/gates; historical proof preservation; EXACT manual demo steps (route to open, buttons, expected states, when real KeeperHub writes occur, how to confirm the new tx, how to reach the Rescue Receipt); blockers; verdict.

## Post-D1 safety reminder

Do NOT run a fresh live demo during implementation. Tests use mocks — zero real writes. The one live website demo is executed manually by the operator per the handoff section.
