# P1 — Monitor Readability + Transaction Links + Telegram Protection Alerts

Date: 2026-08-13
Scope: Post-M10 product UX package. No changes to M0–M10 execution history, no new chain writes, no KeeperHub/blockchain writes. Preservation of the existing premium/minimal UI system (DESIGN.md). This is refinement + notification UX, not a redesign.

Decisions confirmed with the user:
- Telegram binds to the **protected position** (positionId `base-sepolia:aave-v3:usdc:<executionWallet>`) — the app has no authenticated user model; positionId is the universal key.
- Risk alert fires **on the CONFIRMING transition** (fresh confirmation re-read passes, consensus reached), before any execution.
- Settings section lives **inside the existing `/settings` page**.

---

## A. Matched Families readability

### Problem
`components/dashboard/monitor-dashboard.tsx:511-525` renders matched families as an unstyled `<ul className="muted">` with inline `<strong>{family.family}</strong><span>{family.reason}</span>`. There is no `ul/li` CSS in `globals.css`, so family name and reason run together (`ORACLE_PRICE_STATEDRILL condition: ...`).

### Change
- New shared constant map `FAMILY_METRIC_LABEL` in a **client-safe** module (`lib/signal-family-labels.ts`, no `server-only` import):
  - `ORACLE_PRICE_STATE` → `Oracle Price State`
  - `AAVE_RESERVE_STATE` → `Aave Reserve State`
  - `POSITION_STATE` → `Position State`
- New presentational component `components/vindex/matched-family-list.tsx` that renders each matched family as its own stacked row:
  - Row 1: human-readable family name (ink, data typography, uppercase-label convention not required — readable title per spec)
  - Row 2: the real `reason` string (e.g. `DRILL condition: Aave USDC oracle price 1.004234 (8 decimals) <= 1.01 USD.`) on its own line, muted, wrapping naturally
  - Vertical spacing, divider rows, `key` from `family` (enum is unique)
  - Mirror the existing `EmptyEvidenceRow`/`.empty-evidence-row` visual grammar (dot marker, divider, padding) — minimal CSS additions only
- Use it in `monitor-dashboard.tsx` MATCHED FAMILIES block. Same `reason` data, same `matchedFamilies` array — **no signal values or logic change**.
- Apply the same component to the identical crammed pattern in `components/dashboard/rescue-receipt-live.tsx:118-120` (trigger families) for consistency — same data, same presentation.

## B. Transaction links

### Change
- New helper `lib/vindex/basescan.ts` (server-only is fine, but plain function): `buildBaseScanTxUrl(hash)` → `https://sepolia.basescan.org/tx/<fullHash>`, validates `0x`-prefixed 64-hex, throws on invalid input. Constant base from `CANONICAL_CHAIN.explorer.url` in `lib/vindex/chain.ts`.
- New client component `components/vindex/tx-link.tsx`:
  - Props: `txHash` (full hash), optional `label` (default `Tx link`), optional `truncated` hash display
  - Renders `<a href={canonicalUrl} target="_blank" rel="noopener noreferrer">` — plain canonical URL text inside; **never Markdown**
  - Obviously-clickable styling consistent with the design system (ink underline, hover)
- Replace display-only "Tx link" text in `monitor-dashboard.tsx:654-666` — derive href from the verified full `execution.transactionHash` (never from the display string); when hash is absent render an em-dash, not a dead link.
- Refactor existing `rescue-receipt-live.tsx:124` anchor to use `TxLink` derived from `r.transaction?.hash`.
- Sweep other tx-hash displays (evacuation/[executionId], receipt/[receiptId], confirm) for the same treatment where a full hash exists.

## C. Telegram schema (additive, 3 tables)

Drizzle additions to `db/schema.ts` (PostgreSQL):

```
telegram_subscriptions
  id uuid pk defaultRandom
  position_id varchar(128) notNull          -- binds to protected position
  chat_id varchar(64) notNull                -- Telegram IDs are large 64-bit ints
  telegram_username varchar(255) nullable
  risk_alerts_enabled boolean notNull default true
  withdrawal_alerts_enabled boolean notNull default true
  connected_at timestamp notNull defaultNow
  disconnected_at timestamp nullable
  created_at / updated_at
  + uniqueIndex (position_id, chat_id)
  + partial uniqueIndex on position_id WHERE disconnected_at IS NULL  (one active connection per position)

telegram_connect_tokens
  id uuid pk defaultRandom
  token_hash varchar(64) notNull UNIQUE      -- sha256 hex of one-time token; raw token never stored
  position_id varchar(128) notNull
  expires_at timestamp notNull               -- short-lived (~15 min)
  consumed_at timestamp nullable
  created_at

notification_deliveries
  id uuid pk defaultRandom
  subscription_id uuid notNull REFERENCES telegram_subscriptions
  event_type varchar(32) notNull             -- RISK_ALERT | WITHDRAWAL_COMPLETE | TEST
  event_key varchar(128) notNull             -- decision:<id> | receipt:<id> | test:<uuid>
  status varchar(16) notNull                 -- SENT | FAILED
  telegram_message_id varchar(64) nullable
  error_code varchar(64) nullable            -- TELEGRAM_ALERT_FAILED | TELEGRAM_TIMEOUT | TELEGRAM_UNAUTHORIZED | ...
  attempted_at timestamp notNull defaultNow
  sent_at timestamp nullable
  + uniqueIndex (subscription_id, event_type, event_key)   -- dedup guard
```

- Run `npm run db:generate` + `npm run db:migrate` (never `drizzle push`).
- `TELEGRAM_BOT_TOKEN` is read from env only, never stored in DB.
- Migration is purely additive — existing tables/rows untouched.

## D. Connection flow (Bot API deep link)

1. `POST /api/vindex/telegram/connect` (existing route-handler conventions: `runtime = "nodejs"`, `dynamic = "force-dynamic"`, `toApiErrorResponse`, strict body allow-list):
   - resolve positionId from execution wallet (same pattern as `decisions/current`); 404 if no position configured
   - generate `crypto.randomBytes(32).toString("base64url")`; store **sha256 hex** in `telegram_connect_tokens` with `expiresAt = now + 15 min`
   - respond `{ token, botUsername, connectUrl: "https://t.me/<username>?start=<token>", expiresAt }`
   - 503 `SERVER_NOT_CONFIGURED` if `TELEGRAM_BOT_USERNAME`/`TELEGRAM_BOT_TOKEN` unset
2. UI opens `connectUrl` in a new tab (user presses Start in Telegram).
3. `POST /api/integrations/telegram/webhook`:
   - validate `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_WEBHOOK_SECRET` (timing-safe compare); missing/mismatch → 403
   - parse body; handle `message` and `edited_message`; text must match `/start <token>` (or `/start`)
   - lookup by sha256(token): not found / already `consumedAt` set / expired → safe failure (no error to attacker beyond generic message)
   - in a transaction: retire any other active subscription for this position (set `disconnected_at`), upsert subscription `(position_id, chat_id)` restoring `disconnected_at = null`, set `connected_at`, store `from.username` if present
   - consume token (set `consumed_at`) — consume and bind in the same transaction
   - send the concise success message ("Vindex Telegram alerts are connected successfully.") via the delivery client
   - respond 200 promptly; sanitize all errors; never log the token
4. `GET /api/vindex/telegram` → status: `{ connected, telegramUsername?, chatMasked?, riskAlertsEnabled, withdrawalAlertsEnabled, lastDelivery? }` — from DB, never localStorage.
5. `PATCH /api/vindex/telegram` — toggle `riskAlertsEnabled` / `withdrawalAlertsEnabled` (strict body allow-list, 422 on unknown fields).
6. `DELETE /api/vindex/telegram` — soft disconnect (`disconnected_at = now`).
7. `POST /api/vindex/telegram/test` — sends the TEST alert (see E), requires connected subscription.

## E. Telegram delivery service

- `lib/telegram/client.ts` (server-only): `sendTelegramMessage({ chatId, text })` using global `fetch` + Bot API `sendMessage`, `AbortController` timeout (~10 s), typed result `{ ok, messageId?, errorCode? }`. Never logs the bot token or the request URL. Error normalization: timeout, HTTP status, `ok:false` from API, network failure → mapped error codes.
- `lib/vindex/notification-service.ts` (server-only): `notifyRiskAlert(db, decision, position, policy)`, `notifyWithdrawalComplete(db, receipt, execution, position)`, `sendTestAlert(db, positionId)`.
  - Each: load active subscription for positionId → check enabled toggle → build message from **actual records** → attempt send → insert `notification_deliveries` row (`ON CONFLICT (subscription_id, event_type, event_key) DO NOTHING`) → on failure record `status: FAILED`, `error_code`, and an `audit_events` row `TELEGRAM_ALERT_FAILED`.
  - All functions **never throw** — they catch everything and return a result. Telegram can never block, revert, retry, or alter the protection/withdrawal state machine.
  - Transport injectable/vi.mock-able for tests (default real client).

## F. Risk alert (exactly once per decision)

- Trigger site: `lib/vindex/policy-service.ts` — after the CONFIRMING transition succeeds in `confirmationReRead`/`transitionToConfirming` (decision state → `CONFIRMING`, consensus reached). Fire-and-forget `void notifyRiskAlert(...)`; guarded by delivery uniqueness so polling/evaluation can never duplicate.
- `eventType: "RISK_ALERT"`, `eventKey: "decision:<id>"`.
- Content (real data only, exactly per spec shape):

```
⚠️ VINDEX RISK ALERT

Pool: Aave V3 / Base Sepolia
Protected position: USDC
Protected wallet: 0x1234…abcd
Risk state: CONFIRMING
Consensus: 3 / 2 signal families matched

Why Vindex is acting:
• Oracle Price State — <reason from reasonJson>
• Aave Reserve State — <reason from reasonJson>
• Position State — <reason from reasonJson>

Planned action:
Full-position Aave withdrawal → configured safe wallet

Safe wallet:
<safe wallet>

No funds have moved yet.

Protection Drill:
High-sensitivity thresholds using real Base Sepolia measurements. Not evidence of an Aave exploit.
```

- The "Protection Drill" paragraph appears only when `policy.mode === "DRILL_HIGH_SENSITIVITY"`; otherwise a plain closing line.
- Consensus numbers = `decision.matchedCount` / `policy.requiredSignals`; reasons = parsed `reasonJson` per matched family (never fabricated).
- Only families that actually matched appear in the bullets.

## G. Withdrawal / protection alert (only after verified PROTECTED)

- Trigger site: `lib/vindex/verification-service.ts` — after the transaction that sets `executions.status = PROTECTED` and inserts `rescue_receipts` with `status: "PROTECTED"` (destination verification passed, M8 semantics). **Never** at tx submission/confirmation alone.
- `eventType: "WITHDRAWAL_COMPLETE"`, `eventKey: "receipt:<rescueReceiptId>"` — one per receipt.
- Content (per spec):

```
✅ VINDEX POSITION PROTECTED

Pool: Aave V3 / Base Sepolia
Action: Full-position withdrawal
Reason: <policy mode label + consensus summary>

Withdrawn:
<execution.requestedAmount> USDC

Verified received:
<receipt.verifiedAmount> USDC

Safe wallet:
<receipt.destination>

KeeperHub execution:
<keeperhubExecutionId>

Transaction:
https://sepolia.basescan.org/tx/<fullTxHash>

Status:
Destination verified — PROTECTED
```

- For drill executions (`policyMode === "DRILL_HIGH_SENSITIVITY"`): add line `PROTECTION DRILL — HIGH-SENSITIVITY POLICY`.
- Tx URL built by `buildBaseScanTxUrl(receipt.txHash)`.

## H. Delivery safety

- Telegram is observability only: no approval, no wallet change, no policy arm/disarm, no decision creation, no execution trigger, no retry of failed withdrawals anywhere in this package.
- Alert-send failures: protection state preserved, `notification_deliveries` row `FAILED` with `TELEGRAM_ALERT_FAILED`-style error code, optional UI surface in settings ("notification delivery issue"), never repeated blockchain action.

## I. Settings UX

- New client component `components/forms/telegram-settings.tsx` (mirrors `setup-form.tsx` patterns), rendered in `app/(product)/settings/page.tsx` below Route settings as its own section: "Telegram Alerts — Receive risk and verified-withdrawal alerts."
- Disconnected state: `[Connect Telegram]` button (also explain the two-step: connect → press Start in Telegram).
- Connected state: `Connected as @username` (fallback to masked chat id), Risk alerts toggle, Withdrawal alerts toggle, `[Send test alert]`, `[Disconnect]` — status always from `GET /api/vindex/telegram` (DB), never localStorage.
- Connect flow UX: click → POST connect → open `connectUrl` in new tab → poll status for a short window + manual "I've connected" refresh button; success message on connected.
- Toggle changes PATCH and update optimistic state from response.

## J. Tests (Vitest unit, mocked Telegram transport; zero chain writes)

Cover (map from spec §J):
1. matched-family labels/readability structure (component render + label map)
2. canonical BaseScan href from hash; invalid hash rejected
3. Markdown link impossible (TxLink renders an anchor, no `[text](url)` markdown string)
4. connect token: one-time (second consume fails), expiry (expired token fails)
5. webhook secret required (403 without/mismatched `X-Telegram-Bot-Api-Secret-Token`)
6. `/start <token>` binds the correct subscription (positionId + chatId + username)
7. no token stored plaintext (connect token rows store sha256 hex; raw token never in DB)
8. send test alert (content exact, delivery SENT row, once per key)
9. risk alert once per decision (same decision twice → single delivery row)
10. duplicate evaluation cannot duplicate alert (polling loop re-invocation)
11. withdrawal alert only after PROTECTED (SUBMISSION_PENDING / EXECUTED_VERIFYING_DESTINATION / CONFIRMED → no alert; PROTECTED → alert)
12. tx-confirmed-but-not-verified sends no protection alert
13. correct pool/reason/safe wallet/tx link content fields
14. disabled toggle suppresses alert (no delivery row, no send)
15. disconnected user receives none
16. Telegram failure never blocks execution (service throws → state machine unaffected, delivery FAILED row, audit TELEGRAM_ALERT_FAILED)
17. duplicate receipt does not duplicate alert (same receiptId twice → single row)
18. secrets absent from logs/API responses/audit rows (assert no token strings)
19. UI connected/disconnected states (component-level render test; e2e keeps `/settings` smoke green with API aborted)

Update existing `tests/unit/env.test.ts` for the three optional TELEGRAM_* vars (optional — present in `.env.example` placeholders, not required).

## K. Local / deployment handoff

- No webhook needed for localhost automated tests (webhook tested via direct route-handler invocation with forged secret header).
- Operator script `scripts/register-telegram-webhook.ts` (tsx, `react-server` conditions) + npm script `telegram:webhook`: reads `APP_URL` (env or `--url` arg) + `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET`, calls `setWebhook` with `url = <APP_URL>/api/integrations/telegram/webhook` and `secret_token`. Never prints the token; prints the exact steps taken. Does NOT run at app startup/build.
- Docs note added to `.env.example` comments + `docs/` (short "Telegram alerts setup" section): how to deploy, then run `npm run telegram:webhook -- --url https://<app>/`.

## L. Quality gates

- `npm run lint`, `npm run typecheck`, `npm run test:unit`, `npm run test:e2e`, `npm run build`, `npm run db:generate` + `npm run db:migrate`.
- M10 historical proof: `git status`/`git diff` shows zero changes to `artifacts/`, `scripts/demo-m10-e2e.ts`, `lib/vindex/demo-run.ts`, `execution-service.ts` execution paths; DB migration is additive only.
- Zero-chain-write proof: no executed scripts perform chain/KeeperHub writes; only DB migrations + reads; Telegram calls happen only inside unit tests (mocked) and the opt-in operator script (Telegram API, not blockchain).

## Explicit non-goals

- No new auth system, no general Telegram command platform, no Telegram-initiated actions (commands other than `/start` ignored), no Discord/email channels, no redesign, no changes to existing execution history, no `setWebhook` at startup.
