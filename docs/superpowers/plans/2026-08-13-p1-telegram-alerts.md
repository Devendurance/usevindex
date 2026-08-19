# P1 — Monitor Readability + Transaction Links + Telegram Alerts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Post-M10 product UX package: fix the cramped MATCHED FAMILIES display on /monitor, make every Base Sepolia transaction link a real canonical anchor, and add best-effort Telegram risk/withdrawal/test alerts with connection, settings and webhook UX — without touching M0–M10 history or writing to any chain.

**Architecture:** Pure helpers + small client components for the UI fix (A/B); additive Drizzle tables for subscriptions/connect-tokens/deliveries (C); a Bot-API deep-link connection flow via a webhook route at `/api/integrations/telegram/webhook` (D); a server-only fetch-based Telegram client and a never-throwing notification service with DB-level dedup (E–H); a Telegram Alerts section inside the existing `/settings` page (I); an opt-in operator script for webhook registration (K).

**Tech Stack:** Next.js 16.3.0 App Router (route handlers only — no server actions), React 19.2.8, Drizzle ORM 0.45 + postgres-js on PostgreSQL, Vitest 4 (node env, `server-only` stubbed), Playwright 1.55, Tailwind v4 (but the app uses plain global CSS classes).

## Global Constraints

- **Never modify or re-run anything from M0–M10**: no edits to `scripts/demo-m10-e2e.ts`, `lib/vindex/demo-run.ts`, `lib/vindex/execution-service.ts`, `artifacts/**`; never run `demo:m10-e2e`; do not create/fund/supply/withdraw any position; zero KeeperHub writes; zero blockchain writes.
- **Schema changes** go through `npm run db:generate` then `npm run db:migrate`. NEVER run `drizzle push` (AGENTS.md).
- **Server-only convention**: every file in `lib/vindex/**` and `lib/telegram/**` starts with `import "server-only"` (Vitest aliases it to an empty stub). `db/index.ts` exports `getDb()`.
- **TELEGRAM_BOT_TOKEN must never** be stored in the DB, logged, or returned from any API. Only sha256 hashes of connect tokens are persisted.
- **Telegram is observability only**: alerts must never block, revert, retry, or alter the protection/withdrawal state machine. Notification functions never throw.
- **Message text uses ACTUAL records** (decision.reasonJson, matchedCount, receipt/execution fields). Never fabricate signal text or hashes.
- **Design system (DESIGN.md)**: no pills/badges, thin 1px ink borders, no drop shadows, `--muted` (#5c5a54) for secondary text, uppercase only for metadata labels, 44px touch targets, responsive without collisions. No new visual language.
- **API routes** follow the existing pattern: `export const runtime = "nodejs"`, `export const dynamic = "force-dynamic"`, env wrapped in try/catch → 503 `SERVER_NOT_CONFIGURED`, strict body allow-lists (`UNKNOWN_FIELD` 400), errors via `toApiErrorResponse`.
- **Commits**: commit steps are listed per task, but per project policy only run `git commit` when the user has explicitly authorized commits. Otherwise stop after tests pass.
- **Webhook is never registered automatically** at app startup/build. Registration is a separate operator command only.

---

### Task 1: Telegram schema (3 additive tables) + migration

**Files:**
- Modify: `db/schema.ts` (append tables + types at end of file)
- Test: `tests/unit/telegram-schema.test.ts`
- Generated: `drizzle/0008_*.sql` via `npm run db:generate` + `npm run db:migrate`

**Interfaces:**
- Produces: exported tables `telegramSubscriptions`, `telegramConnectTokens`, `notificationDeliveries` and row types `TelegramSubscriptionRow`, `TelegramConnectTokenRow`, `NotificationDeliveryRow` (used by every later task).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/telegram-schema.test.ts`:

```ts
// P1 schema: subscription, connect-token (hash only) and delivery dedup
// constraints. The bot token itself must never appear in the schema.

import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";

import {
  notificationDeliveries,
  telegramConnectTokens,
  telegramSubscriptions,
} from "../../db/schema";
import { closeTestDb, getTestDb, hasDatabaseUrl } from "./helpers/test-db";

const dbAvailable = Boolean(process.env.DATABASE_URL?.trim());
let db: Awaited<ReturnType<typeof getTestDb>>;

const POSITION_ID = "base-sepolia:aave-v3:usdc:0x675638ddbbf8b70b906d68e3485da72c6c63d130";

beforeAll(async () => {
  if (!dbAvailable) return;
  db = await getTestDb();
  await db.delete(notificationDeliveries);
  await db.delete(telegramSubscriptions);
  await db.delete(telegramConnectTokens);
});

afterAll(async () => {
  await closeTestDb();
});

describe("telegram subscriptions", () => {
  it.skipIf(!dbAvailable)("stores one active subscription per position", async () => {
    await db.insert(telegramSubscriptions).values({
      positionId: POSITION_ID,
      chatId: "101",
      telegramUsername: "user_one",
      riskAlertsEnabled: true,
      withdrawalAlertsEnabled: true,
    });
    await db.insert(telegramSubscriptions).values({
      positionId: POSITION_ID,
      chatId: "102",
      telegramUsername: "user_two",
      riskAlertsEnabled: true,
      withdrawalAlertsEnabled: true,
      disconnectedAt: new Date(),
    });
    const rows = await db.select().from(telegramSubscriptions);
    expect(rows.filter((r) => r.disconnectedAt === null)).toHaveLength(1);
    expect(rows.filter((r) => r.chatId === "101")).toHaveLength(1);
  });

  it.skipIf(!dbAvailable)("chat IDs are stored as strings (large Telegram IDs)", async () => {
    const big = "900719925474099312345";
    await db.insert(telegramSubscriptions).values({
      positionId: POSITION_ID,
      chatId: big,
      riskAlertsEnabled: true,
      withdrawalAlertsEnabled: true,
    });
    const rows = await db.select().from(telegramSubscriptions).where(eq(telegramSubscriptions.chatId, big));
    expect(rows[0]?.chatId).toBe(big);
  });
});

describe("connect tokens", () => {
  it.skipIf(!dbAvailable)("the token hash column is unique", async () => {
    await db.insert(telegramConnectTokens).values({
      tokenHash: "abc123",
      positionId: POSITION_ID,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      db.insert(telegramConnectTokens).values({
        tokenHash: "abc123",
        positionId: POSITION_ID,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow();
  });
});

describe("notification deliveries", () => {
  it.skipIf(!dbAvailable)("the (subscriptionId, eventType, eventKey) triple is unique", async () => {
    const [sub] = await db
      .insert(telegramSubscriptions)
      .values({
        positionId: POSITION_ID,
        chatId: "103",
        riskAlertsEnabled: true,
        withdrawalAlertsEnabled: true,
      })
      .returning({ id: telegramSubscriptions.id });
    const subscriptionId = sub.id;
    await db.insert(notificationDeliveries).values({
      subscriptionId,
      eventType: "RISK_ALERT",
      eventKey: "decision:x",
      status: "SENT",
    });
    await expect(
      db.insert(notificationDeliveries).values({
        subscriptionId,
        eventType: "RISK_ALERT",
        eventKey: "decision:x",
        status: "SENT",
      }),
    ).rejects.toThrow();
    const rows = await db.select().from(notificationDeliveries);
    expect(rows.filter((r) => r.eventKey === "decision:x")).toHaveLength(1);
  });
});

describe("secret hygiene", () => {
  it("the schema never stores the bot token", async () => {
    const source = await readFile("db/schema.ts", "utf8");
    expect(source).not.toMatch(/bot_?token/i);
    expect(source).not.toMatch(/TELEGRAM_BOT_TOKEN/);
  });
});
```

Note: the `.returning()` builder must be awaited in the form shown in the test above (`.returning({ id: ... })` on the insert builder) — it compiles and runs with drizzle + postgres-js.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- --run tests/unit/telegram-schema.test.ts`
Expected: FAIL — `telegramSubscriptions is not defined` / table missing.

- [ ] **Step 3: Add the three tables to `db/schema.ts`**

Append after `demoRuns` (end of file):

```ts
// P1: Telegram alerting. Subscriptions bind to the protected position
// (positionId) — Vindex has no user/auth model. Only token HASHES are stored;
// TELEGRAM_BOT_TOKEN never touches the database.
export const telegramSubscriptions = pgTable(
  "telegram_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    positionId: varchar("position_id", { length: 128 }).notNull(),
    chatId: varchar("chat_id", { length: 64 }).notNull(),
    telegramUsername: varchar("telegram_username", { length: 255 }),
    riskAlertsEnabled: boolean("risk_alerts_enabled").notNull().default(true),
    withdrawalAlertsEnabled: boolean("withdrawal_alerts_enabled").notNull().default(true),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("telegram_subscriptions_position_chat_uniq").on(table.positionId, table.chatId),
    // One active connection per position.
    uniqueIndex("telegram_subscriptions_active_uniq")
      .on(table.positionId)
      .where(sql`${table.disconnectedAt} is null`),
  ],
);

export const telegramConnectTokens = pgTable(
  "telegram_connect_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    positionId: varchar("position_id", { length: 128 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("telegram_connect_tokens_hash_uniq").on(table.tokenHash)],
);

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id").notNull(),
    eventType: varchar("event_type", { length: 32 }).notNull(),
    eventKey: varchar("event_key", { length: 128 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    telegramMessageId: varchar("telegram_message_id", { length: 64 }),
    errorCode: varchar("error_code", { length: 64 }),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One delivery per (subscription, event type, event key) — alerts cannot duplicate.
    uniqueIndex("notification_deliveries_dedup_uniq").on(
      table.subscriptionId,
      table.eventType,
      table.eventKey,
    ),
  ],
);

export type TelegramSubscriptionRow = typeof telegramSubscriptions.$inferSelect;
export type TelegramConnectTokenRow = typeof telegramConnectTokens.$inferSelect;
export type NotificationDeliveryRow = typeof notificationDeliveries.$inferSelect;
```

- [ ] **Step 4: Generate and apply the migration**

Run: `npm run db:generate` — expected: creates `drizzle/0008_*.sql` containing only the three new tables and their indexes (additive; verify with `git diff drizzle/` that no existing table is altered).
Run: `npm run db:migrate` — expected: applies the migration successfully.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:unit -- --run tests/unit/telegram-schema.test.ts`
Expected: PASS (DB tests skip gracefully when `DATABASE_URL` is absent; run locally with `.env` present).

- [ ] **Step 6: Commit**

```bash
git add db/schema.ts drizzle tests/unit/telegram-schema.test.ts
git commit -m "feat: add telegram subscriptions, connect tokens, notification deliveries schema"
```

---

### Task 2: Optional Telegram env vars + `.env.example` placeholders

**Files:**
- Modify: `lib/vindex/env.ts`, `.env.example`
- Modify: `tests/unit/env.test.ts` (exists — check current shape, append new describes)

**Interfaces:**
- Produces: `type TelegramEnv = { botToken: string; botUsername: string; webhookSecret: string }` and `getTelegramEnv(env?: NodeJS.ProcessEnv): TelegramEnv | null` — optional (returns `null` when any var is missing); `getServerEnv` is unchanged and `REQUIRED_ENV_VARS` is unchanged.

- [ ] **Step 1: Write the failing test additions**

Append to `tests/unit/env.test.ts`:

```ts
import { getTelegramEnv } from "../../lib/vindex/env";

describe("getTelegramEnv", () => {
  it("returns null when any Telegram variable is missing", () => {
    expect(getTelegramEnv({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_BOT_USERNAME: "VindexAlertsBot" })).toBeNull();
    expect(getTelegramEnv({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_WEBHOOK_SECRET: "s" })).toBeNull();
    expect(getTelegramEnv({})).toBeNull();
    expect(getTelegramEnv({ TELEGRAM_BOT_TOKEN: "   ", TELEGRAM_BOT_USERNAME: "B", TELEGRAM_WEBHOOK_SECRET: "s" })).toBeNull();
  });

  it("returns trimmed values when all three are set", () => {
    const env = getTelegramEnv({
      TELEGRAM_BOT_TOKEN: " 123:abc ",
      TELEGRAM_BOT_USERNAME: " VindexAlertsBot ",
      TELEGRAM_WEBHOOK_SECRET: " long-random-secret ",
    });
    expect(env).toEqual({ botToken: "123:abc", botUsername: "VindexAlertsBot", webhookSecret: "long-random-secret" });
  });

  it("getServerEnv does not require Telegram variables", () => {
    expect(() => getServerEnv({ BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org", KEEPERHUB_API_KEY: "kh_test_key_123456" })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- --run tests/unit/env.test.ts`
Expected: FAIL — `getTelegramEnv is not exported`.

- [ ] **Step 3: Implement `getTelegramEnv` in `lib/vindex/env.ts`**

Append to the file (after `isServerEnvComplete`):

```ts
export type TelegramEnv = {
  botToken: string;
  botUsername: string;
  webhookSecret: string;
};

// Telegram alerting is optional and best-effort: alerts never block the
// protection state machine, so these variables are NOT part of REQUIRED_ENV_VARS.
export function getTelegramEnv(env: NodeJS.ProcessEnv = process.env): TelegramEnv | null {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const botUsername = env.TELEGRAM_BOT_USERNAME?.trim();
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!botToken || !botUsername || !webhookSecret) return null;
  return { botToken, botUsername, webhookSecret };
}
```

- [ ] **Step 4: Add placeholders to `.env.example`**

Append to `.env.example`:

```bash
# Telegram alert delivery (OPTIONAL — best-effort observability, never blocks
# protection). Create a bot with @BotFather. TELEGRAM_WEBHOOK_SECRET is a long
# random string you choose; it is validated on every webhook request.
# TELEGRAM_BOT_TOKEN=123456789:AA...your-bot-token
# TELEGRAM_BOT_USERNAME=YourVindexAlertsBot
# TELEGRAM_WEBHOOK_SECRET=replace_with_a_long_random_secret

# Used only by `npm run telegram:webhook` after HTTPS deployment.
# APP_URL=https://your-deployed-app.example
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:unit -- --run tests/unit/env.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/vindex/env.ts .env.example tests/unit/env.test.ts
git commit -m "feat: optional telegram env vars with .env.example placeholders"
```

---

### Task 3: BaseScan URL helper + `TxLink` component

**Files:**
- Create: `lib/vindex/basescan.ts`, `components/vindex/tx-link.tsx`
- Modify: `app/globals.css` (add `.tx-link` styles)
- Test: `tests/unit/basescan.test.ts`

**Interfaces:**
- Produces:
  - `buildBaseScanTxUrl(txHash: string): string` — canonical `https://sepolia.basescan.org/tx/<fullHash>`; throws `Error` on non-`0x`+64-hex input.
  - `safeBaseScanTxUrl(txHash: string | null): string | null` — never throws; `null` in → `null` out; invalid → `null`.
  - `TxLink({ href, children?, className? }: { href: string; children?: React.ReactNode; className?: string })` — `<a target="_blank" rel="noopener noreferrer">`, default children `"Tx link"`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/basescan.test.ts`:

```ts
// Canonical BaseScan Sepolia links: href is always derived from the full
// verified transaction hash and is always a plain URL — Markdown is impossible.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { buildBaseScanTxUrl, safeBaseScanTxUrl } from "../../lib/vindex/basescan";

const HASH = "0x22670c665c86ad8d782fa1ff954ff4b6bf20a29d66a715378ed9d90efdf0f0806";
const EXPECTED = `https://sepolia.basescan.org/tx/${HASH}`;

describe("buildBaseScanTxUrl", () => {
  it("builds the canonical href from the full hash", () => {
    expect(buildBaseScanTxUrl(HASH)).toBe(EXPECTED);
  });

  it("trims surrounding whitespace", () => {
    expect(buildBaseScanTxUrl(`  ${HASH}  `)).toBe(EXPECTED);
  });

  it("rejects invalid hashes", () => {
    expect(() => buildBaseScanTxUrl("0x1234")).toThrow();
    const upperHex = `0x${HASH.slice(2).toUpperCase()}`;
    expect(() => buildBaseScanTxUrl(upperHex)).not.toThrow(); // hex letters may be upper-case
    expect(() => buildBaseScanTxUrl(`${HASH}ff`)).toThrow(); // 65 hex chars
    expect(() => buildBaseScanTxUrl("https://sepolia.basescan.org/tx/abc")).toThrow();
    expect(() => buildBaseScanTxUrl("")).toThrow();
  });
});

describe("safeBaseScanTxUrl", () => {
  it("returns null instead of throwing", () => {
    expect(safeBaseScanTxUrl(null)).toBeNull();
    expect(safeBaseScanTxUrl("0x1234")).toBeNull();
    expect(safeBaseScanTxUrl(HASH)).toBe(EXPECTED);
  });
});

describe("TxLink markup", () => {
  it("renders a plain anchor with target/rel and no Markdown", async () => {
    const source = await readFile("components/vindex/tx-link.tsx", "utf8");
    expect(source).toContain('target="_blank"');
    expect(source).toContain('rel="noopener noreferrer"');
    expect(source).toContain("href=");
    // The component must render an <a>, never a Markdown "[url](url)" string.
    expect(source).not.toMatch(/\[[^\]]+\]\(/);
    expect(source).not.toMatch(/`\[|\[https?:\/\//);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- --run tests/unit/basescan.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `lib/vindex/basescan.ts`:

```ts
import { CANONICAL_CHAIN } from "./chain";

const TX_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;

export const buildBaseScanTxUrl = (txHash: string): string => {
  const trimmed = txHash.trim();
  if (!TX_HASH_PATTERN.test(trimmed)) {
    throw new Error(`Not a valid transaction hash: ${trimmed}`);
  }
  return `${CANONICAL_CHAIN.explorer.url}/tx/${trimmed}`;
};

export const safeBaseScanTxUrl = (txHash: string | null): string | null => {
  if (txHash === null) return null;
  try {
    return buildBaseScanTxUrl(txHash);
  } catch {
    return null;
  }
};
```

- [ ] **Step 4: Implement the component**

Create `components/vindex/tx-link.tsx`:

```tsx
// Canonical Base Sepolia transaction link. The href is always the plain,
// full canonical URL — never Markdown. Transaction hashes may stay truncated
// as the visible label.
export function TxLink({
  href,
  children = "Tx link",
  className,
}: {
  href: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <a className={className ?? "tx-link"} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
```

- [ ] **Step 5: Add the `.tx-link` style to `app/globals.css`**

Append (near the other component styles, e.g. after `.evidence-line strong` block ~line 1018):

```css
.tx-link {
  color: var(--ink);
  font-weight: 700;
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
  overflow-wrap: anywhere;
}

.tx-link:hover {
  opacity: 0.7;
}
```

- [ ] **Step 6: Run the tests**

Run: `npm run test:unit -- --run tests/unit/basescan.test.ts` — PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/vindex/basescan.ts components/vindex/tx-link.tsx app/globals.css tests/unit/basescan.test.ts
git commit -m "feat: canonical BaseScan tx link helper and TxLink component"
```

---

### Task 4: Wire TxLink into monitor + rescue receipt

**Files:**
- Modify: `components/dashboard/monitor-dashboard.tsx` (lines ~653–671, the TRANSACTION card)
- Modify: `components/dashboard/rescue-receipt-live.tsx` (lines ~108–109, ~124)
- Test: extend `tests/unit/basescan.test.ts` with a source-assertion on both dashboards (no Markdown, href derived from the hash, not from the display link string)

**Interfaces:**
- Consumes: `safeBaseScanTxUrl` (Task 3), `TxLink` (Task 3).

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/basescan.test.ts`:

```ts
describe("dashboard tx link integration", () => {
  it("monitor derives the href from the full transactionHash", async () => {
    const source = await readFile("components/dashboard/monitor-dashboard.tsx", "utf8");
    expect(source).toContain("safeBaseScanTxUrl");
    expect(source).toContain("TxLink");
    // Never from the presentation string "sepolia.basescan.org" or the link field.
    expect(source).not.toMatch(/href=.*transactionLink/);
    expect(source).not.toMatch(/"sepolia\.basescan\.org"/);
  });

  it("the rescue receipt derives links from the verified hash", async () => {
    const source = await readFile("components/dashboard/rescue-receipt-live.tsx", "utf8");
    expect(source).toContain("safeBaseScanTxUrl");
    expect(source).toContain("TxLink");
    expect(source).not.toMatch(/href=\{[^}]*\.link/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- --run tests/unit/basescan.test.ts`
Expected: FAIL (dashboard still renders plain text).

- [ ] **Step 3: Update the monitor TRANSACTION card**

In `components/dashboard/monitor-dashboard.tsx`:

1. Add imports:
```tsx
import { safeBaseScanTxUrl } from "@/lib/vindex/basescan";
import { TxLink } from "@/components/vindex/tx-link";
```
2. Replace the "Tx link" evidence row (currently lines 661–666) with:

```tsx
<div className="evidence-line">
  <span>Tx link</span>
  {execution.transactionHash !== null ? (
    <TxLink href={safeBaseScanTxUrl(execution.transactionHash) ?? "#"} />
  ) : (
    <strong className="empty-dash">—</strong>
  )}
</div>
```

The "Tx hash" row above stays unchanged (shortened via `formatWallet`).

- [ ] **Step 4: Update the rescue receipt page**

In `components/dashboard/rescue-receipt-live.tsx`:

1. Add imports:
```tsx
import { safeBaseScanTxUrl } from "@/lib/vindex/basescan";
import { TxLink } from "@/components/vindex/tx-link";
```
2. Replace line 108–109 (Transaction + Transaction link rows) with truncated-hash anchor + link row:

```tsx
<div className="evidence-line">
  <span>Transaction</span>
  {r.transaction?.hash ? (
    <TxLink href={safeBaseScanTxUrl(r.transaction.hash) ?? "#"}>
      {r.transaction.hash.length > 18 ? `${r.transaction.hash.slice(0, 10)}…${r.transaction.hash.slice(-6)}` : r.transaction.hash}
    </TxLink>
  ) : (
    <strong>—</strong>
  )}
</div>
<div className="evidence-line">
  <span>Transaction link</span>
  {r.transaction?.hash ? (
    <TxLink href={safeBaseScanTxUrl(r.transaction.hash) ?? "#"}>View on BaseScan Sepolia</TxLink>
  ) : (
    <strong>—</strong>
  )}
</div>
```
3. Replace the bottom action button (line 124) so the href comes from the hash:

```tsx
{r.transaction?.hash ? (
  <a className="secondary-button" href={safeBaseScanTxUrl(r.transaction.hash) ?? "#"} target="_blank" rel="noopener noreferrer">View on BaseScan Sepolia</a>
) : null}
```

(If the source assertion requires no `r.transaction?.link` usage at all, delete the now-unused plain-link row content. Keep `link` in the `ReceiptResponse` type as-is — it is part of the persisted receipt shape.)

- [ ] **Step 5: Run tests**

Run: `npm run test:unit -- --run tests/unit/basescan.test.ts` — PASS.

- [ ] **Step 6: Verify e2e compatibility**

The existing e2e assertion `toContainText("sepolia.basescan.org")` (tests/e2e/vindex.spec.ts:971) matches the anchor href — no e2e change needed for monitor. Confirm later in Task 13.

- [ ] **Step 7: Commit**

```bash
git add components/dashboard/monitor-dashboard.tsx components/dashboard/rescue-receipt-live.tsx tests/unit/basescan.test.ts
git commit -m "feat: clickable canonical transaction links in monitor and rescue receipt"
```

---

### Task 5: Matched-family labels + stacked `MatchedFamilyList` component

**Files:**
- Create: `lib/signal-family-labels.ts`, `components/vindex/matched-family-list.tsx`
- Modify: `components/dashboard/monitor-dashboard.tsx` (MATCHED FAMILIES block lines 511–525; replace local `FAMILY_METRIC_LABEL` with the shared import), `components/dashboard/rescue-receipt-live.tsx` (trigger families lines 118–120), `app/globals.css`
- Test: `tests/unit/signal-family-labels.test.ts`

**Interfaces:**
- Produces:
  - `FAMILY_METRIC_LABEL: Record<string, string>` — `{ ORACLE_PRICE_STATE: "Oracle Price State", AAVE_RESERVE_STATE: "Aave Reserve State", POSITION_STATE: "Position State" }`
  - `formatFamilyLabel(family: string): string` — label or fallback `family.replace(/_/g, " ")`
  - `MatchedFamilyList({ families }: { families: Array<{ family: string; reason: string }> })` — stacked rows, one per family. Must NOT import `server-only` (it is used from client components).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/signal-family-labels.test.ts`:

```ts
// P1 matched-family readability: human labels, one stacked row per family,
// and the component never re-introduces the run-on "FAMILYreason" markup.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { FAMILY_METRIC_LABEL, formatFamilyLabel } from "../../lib/signal-family-labels";

describe("family labels", () => {
  it("maps the three signal families to readable labels", () => {
    expect(FAMILY_METRIC_LABEL.ORACLE_PRICE_STATE).toBe("Oracle Price State");
    expect(FAMILY_METRIC_LABEL.AAVE_RESERVE_STATE).toBe("Aave Reserve State");
    expect(FAMILY_METRIC_LABEL.POSITION_STATE).toBe("Position State");
  });

  it("falls back to a spaced enum name for unknown families", () => {
    expect(formatFamilyLabel("SOME_NEW_FAMILY")).toBe("Some New Family".toUpperCase() === formatFamilyLabel("SOME_NEW_FAMILY") ? "SOME_NEW_FAMILY".replace(/_/g, " ") : "SOME_NEW_FAMILY".replace(/_/g, " "));
    // simpler, deterministic assertion:
    expect(formatFamilyLabel("SOME_NEW_FAMILY")).toBe("SOME NEW FAMILY");
  });

  it("labels are human-readable (no raw enum names)", () => {
    expect(formatFamilyLabel("ORACLE_PRICE_STATE")).not.toContain("_");
    expect(FAMILY_METRIC_LABEL.AAVE_RESERVE_STATE.toLowerCase()).toContain("aave");
  });
});

describe("MatchedFamilyList markup", () => {
  it("renders a separate row per family with the reason on its own line", async () => {
    const source = await readFile("components/vindex/matched-family-list.tsx", "utf8");
    expect(source).toContain("formatFamilyLabel");
    expect(source).toContain("key={family.family}");
    // The reason must be its own element, not concatenated with the family name.
    expect(source).not.toMatch(/\{family\.family\}\{family\.reason\}|<strong>\{family\.family\}<span>/);
    // No server-only import (client component).
    expect(source).not.toContain("server-only");
  });

  it("monitor and receipt use the shared component instead of inline lists", async () => {
    const monitor = await readFile("components/dashboard/monitor-dashboard.tsx", "utf8");
    expect(monitor).toContain("<MatchedFamilyList");
    expect(monitor).not.toMatch(/<ul className="muted">[\s\S]*matchedFamilies\.map/);
    const receipt = await readFile("components/dashboard/rescue-receipt-live.tsx", "utf8");
    expect(receipt).toContain("<MatchedFamilyList");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- --run tests/unit/signal-family-labels.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the labels module**

Create `lib/signal-family-labels.ts` (NO `server-only` import — shared client/server):

```ts
export const FAMILY_METRIC_LABEL: Record<string, string> = {
  ORACLE_PRICE_STATE: "Oracle Price State",
  AAVE_RESERVE_STATE: "Aave Reserve State",
  POSITION_STATE: "Position State",
};

export const formatFamilyLabel = (family: string): string =>
  FAMILY_METRIC_LABEL[family] ?? family.replace(/_/g, " ");
```

- [ ] **Step 4: Implement the component**

Create `components/vindex/matched-family-list.tsx`:

```tsx
import { formatFamilyLabel } from "@/lib/signal-family-labels";

type MatchedFamily = {
  family: string;
  reason: string;
};

export function MatchedFamilyList({ families }: { families: MatchedFamily[] }) {
  return (
    <ul className="matched-family-list">
      {families.map((family) => (
        <li className="matched-family-row" key={family.family}>
          <strong className="matched-family-row__title">{formatFamilyLabel(family.family)}</strong>
          <span className="matched-family-row__reason">{family.reason}</span>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 5: Add CSS to `app/globals.css`**

```css
.matched-family-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.matched-family-row {
  display: grid;
  gap: 5px;
  padding: 14px 0;
  border-bottom: 1px solid var(--divider);
}

.matched-family-row:last-child {
  border-bottom: none;
}

.matched-family-row__title {
  font-size: 0.95rem;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.matched-family-row__reason {
  color: var(--muted);
  font-size: 0.86rem;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
```

- [ ] **Step 6: Wire into the monitor**

In `components/dashboard/monitor-dashboard.tsx`:
1. Replace the local `FAMILY_METRIC_LABEL` constant (lines 112–116) with:
```tsx
import { FAMILY_METRIC_LABEL } from "@/lib/signal-family-labels";
```
(delete the local constant).
2. Import `MatchedFamilyList` from `@/components/vindex/matched-family-list`.
3. Replace the MATCHED FAMILIES block (lines 511–525) with:

```tsx
<div className="route-card">
  <p className="data-label">MATCHED FAMILIES</p>
  {decision === null || decision.matchedFamilies.length === 0 ? (
    <p className="form-note">No matched families.</p>
  ) : (
    <MatchedFamilyList
      families={decision.matchedFamilies.map((family) => ({
        family: family.family,
        reason: family.reason,
      }))}
    />
  )}
</div>
```

- [ ] **Step 7: Wire into the rescue receipt trigger**

In `components/dashboard/rescue-receipt-live.tsx`:
1. Import `MatchedFamilyList`.
2. Replace lines 118–120 with:

```tsx
{r.trigger?.families !== undefined && r.trigger.families.length > 0 && (
  <MatchedFamilyList
    families={r.trigger.families.map((family) => ({
      family: family.family ?? "UNKNOWN",
      reason: family.reason ?? "",
    }))}
  />
)}
```

- [ ] **Step 8: Run tests**

Run: `npm run test:unit -- --run tests/unit/signal-family-labels.test.ts` — PASS.
Run: `npm run typecheck` — PASS (watch the import of `FAMILY_METRIC_LABEL` removal).

- [ ] **Step 9: Commit**

```bash
git add lib/signal-family-labels.ts components/vindex/matched-family-list.tsx components/dashboard/monitor-dashboard.tsx components/dashboard/rescue-receipt-live.tsx app/globals.css tests/unit/signal-family-labels.test.ts
git commit -m "feat: readable stacked matched-family rows on monitor and receipt"
```

---

### Task 6: Telegram delivery client (fetch + Bot API, bounded, sanitized)

**Files:**
- Create: `lib/telegram/client.ts`
- Test: `tests/unit/telegram-client.test.ts`

**Interfaces:**
- Produces:
  - `type TelegramSendResult = { ok: boolean; messageId: string | null; errorCode: string | null }`
  - `sendTelegramMessage(options: { botToken: string; chatId: string; text: string; timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<TelegramSendResult>`
  - Error codes: `TELEGRAM_TIMEOUT`, `TELEGRAM_NETWORK`, `TELEGRAM_HTTP_<status or api error_code>`. Never throws. Never logs token/URL.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/telegram-client.test.ts`:

```ts
// P1 Telegram transport: bounded, sanitized, never throws, never logs secrets.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { sendTelegramMessage } from "../../lib/telegram/client";

const BOT_TOKEN = "123456789:AA-test-token";
const CHAT_ID = "42424242";
const TEXT = "Vindex Telegram alerts are connected successfully.";

const okFetch = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("sendTelegramMessage", () => {
  it("returns the message id on success", async () => {
    const result = await sendTelegramMessage({
      botToken: BOT_TOKEN,
      chatId: CHAT_ID,
      text: TEXT,
      fetchImpl: okFetch({ ok: true, result: { message_id: 42 } }),
    });
    expect(result).toEqual({ ok: true, messageId: "42", errorCode: null });
  });

  it("maps HTTP failures to sanitized codes", async () => {
    const result = await sendTelegramMessage({
      botToken: BOT_TOKEN,
      chatId: CHAT_ID,
      text: TEXT,
      fetchImpl: okFetch({ ok: false, error_code: 403, description: "bot was blocked by the user" }, 403),
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("TELEGRAM_HTTP_403");
    expect(result.messageId).toBeNull();
  });

  it("maps network failures without leaking the URL", async () => {
    const result = await sendTelegramMessage({
      botToken: BOT_TOKEN,
      chatId: CHAT_ID,
      text: TEXT,
      fetchImpl: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    expect(result).toEqual({ ok: false, messageId: null, errorCode: "TELEGRAM_NETWORK" });
  });

  it("maps timeouts to TELEGRAM_TIMEOUT", async () => {
    const result = await sendTelegramMessage({
      botToken: BOT_TOKEN,
      chatId: CHAT_ID,
      text: TEXT,
      timeoutMs: 5,
      fetchImpl: vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          }),
      ),
    });
    expect(result).toEqual({ ok: false, messageId: null, errorCode: "TELEGRAM_TIMEOUT" });
  });
});

describe("secret hygiene", () => {
  it("the client never logs the token or the request URL", async () => {
    const source = await readFile("lib/telegram/client.ts", "utf8");
    expect(source).not.toMatch(/console\./);
    expect(source).not.toMatch(/api\.telegram\.org\/bot/); // URL is constructed dynamically
  });
});
```

(Add `import { vi } from "vitest";` at the top — the snippet above uses it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- --run tests/unit/telegram-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the client**

Create `lib/telegram/client.ts`:

```ts
// P1 Telegram Bot API transport. Observability only: bounded by timeout,
// sanitized error codes, never throws. The bot token and the full request URL
// must never be logged anywhere.

import "server-only";

export type TelegramSendResult = {
  ok: boolean;
  messageId: string | null;
  errorCode: string | null;
};

export type SendTelegramMessageOptions = {
  botToken: string;
  chatId: string;
  text: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 10_000;

export const sendTelegramMessage = async (
  options: SendTelegramMessageOptions,
): Promise<TelegramSendResult> => {
  const { botToken, chatId, text, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: { message_id?: number };
      description?: string;
      error_code?: number;
    } | null;
    if (!response.ok || body?.ok !== true) {
      const apiCode = body?.error_code;
      return {
        ok: false,
        messageId: null,
        errorCode: apiCode !== undefined ? `TELEGRAM_HTTP_${apiCode}` : `TELEGRAM_HTTP_${response.status}`,
      };
    }
    return {
      ok: true,
      messageId: body.result?.message_id !== undefined ? String(body.result.message_id) : null,
      errorCode: null,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, messageId: null, errorCode: "TELEGRAM_TIMEOUT" };
    }
    return { ok: false, messageId: null, errorCode: "TELEGRAM_NETWORK" };
  } finally {
    clearTimeout(timeout);
  }
};
```

- [ ] **Step 4: Run tests**

Run: `npm run test:unit -- --run tests/unit/telegram-client.test.ts` — PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/telegram/client.ts tests/unit/telegram-client.test.ts
git commit -m "feat: bounded sanitized Telegram Bot API client"
```

---

### Task 7: Notification service — message builders, dedup delivery, never throws

**Files:**
- Create: `lib/vindex/notification-service.ts`
- Test: `tests/unit/notification-service.test.ts`

**Interfaces:**
- Consumes: `getTelegramEnv` (Task 2), `sendTelegramMessage` (Task 6), `formatFamilyLabel` (Task 5), `buildBaseScanTxUrl` (Task 3), tables from Task 1, `DRILL_LABEL` from `lib/vindex/policy-templates`.
- Produces:
  - `type NotificationEventType = "RISK_ALERT" | "WITHDRAWAL_COMPLETE" | "TEST"`
  - `type NotificationOutcome = { delivered: boolean; deduplicated: boolean; failed: boolean; errorCode: string | null; eventType: NotificationEventType; eventKey: string }`
  - `buildRiskAlertMessage({ position, policy, matchedFamilies }): string`
  - `buildWithdrawalAlertMessage({ position, receipt, execution, policyMode, policyLabel }): string`
  - `notifyRiskAlert({ db, positionId, decision, policy, matchedFamilies }): Promise<NotificationOutcome>` — eventKey `decision:<id>`
  - `notifyWithdrawalComplete({ db, positionId, receipt, execution, policyMode, policyLabel }): Promise<NotificationOutcome>` — eventKey `receipt:<id>`; no-op unless `receipt.status === "PROTECTED"` (structurally typed `receipt` param — see below)
  - `sendTestAlert({ db, positionId }): Promise<NotificationOutcome>` — eventKey `test:<uuid>`, fixed text `Vindex Telegram alerts are connected successfully.`
  - `type WithdrawalReceiptFacts = { id: string; status: string; verifiedAmount: string; destination: string; txHash: string; keeperhubExecutionId: string; policyMode: string }` — structurally satisfied by both `RescueReceiptRow` and `RescueReceiptView`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/notification-service.test.ts`:

```ts
// P1 Telegram delivery: content from REAL records, exactly-once dedup per
// event key, toggle gating, PROTECTED-only withdrawal alerts, and failures
// that never throw and never touch the protection state machine. The Telegram
// transport is mocked — zero real network, zero blockchain writes.

import { describe, expect, it, vi, afterAll, beforeAll, beforeEach } from "vitest";

import { and, eq } from "drizzle-orm";

import {
  auditEvents,
  executions,
  notificationDeliveries,
  protectedPositions,
  rescueReceipts,
  telegramSubscriptions,
  threatDecisions,
} from "../../db/schema";
import {
  buildRiskAlertMessage,
  buildWithdrawalAlertMessage,
  notifyRiskAlert,
  notifyWithdrawalComplete,
  sendTestAlert,
} from "../../lib/vindex/notification-service";
import type { MatchedFamilyView, PolicyView } from "../../lib/vindex/policy-service";
import { closeTestDb, getTestDb } from "./helpers/test-db";

vi.mock("../../lib/telegram/client", () => ({
  sendTelegramMessage: vi.fn(async () => ({ ok: true, messageId: "100", errorCode: null })),
}));
import { sendTelegramMessage } from "../../lib/telegram/client";
const mockSend = vi.mocked(sendTelegramMessage);

const dbAvailable = Boolean(process.env.DATABASE_URL?.trim());
let db: Awaited<ReturnType<typeof getTestDb>>;

const WALLET = "0x675638ddbbf8b70b906d68e3485da72c6c63d130";
const SAFE_WALLET = "0x2222222222222222222222222222222222222222";
const POSITION_ID = `base-sepolia:aave-v3:usdc:${WALLET}`;
const DECISION_ID = "00000000-0000-4000-8000-000000000001";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000002";
const RECEIPT_ID = "00000000-0000-4000-8000-000000000003";
const TX_HASH = "0x22670c665c86ad8d782fa1ff954ff4b6bf20a29d66a715378ed9d90efdf0f0806";

const positionRow = {
  id: POSITION_ID,
  chainId: 84532,
  protocol: "aave-v3",
  poolAddress: `0x${"11".repeat(20)}`,
  assetAddress: `0x${"22".repeat(20)}`,
  assetSymbol: "USDC",
  assetDecimals: 6,
  positionTokenAddress: `0x${"33".repeat(20)}`,
  executionWallet: WALLET,
  safeWallet: SAFE_WALLET,
  latestPositionAmount: "5000077",
  latestUnderlyingWalletBalance: "0",
  latestNativeBalanceWei: "20000000000000000",
  latestAllowance: "0",
  latestBlockNumber: "45384000",
  latestBlockTimestamp: new Date(),
  observedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

const policy: PolicyView = {
  id: "00000000-0000-4000-8000-00000000000a",
  positionId: POSITION_ID,
  mode: "DRILL_HIGH_SENSITIVITY",
  version: 1,
  requiredSignals: 2,
  correlationWindowSec: 600,
  thresholds: {},
  safeWalletSnapshot: SAFE_WALLET,
  isArmed: true,
  armedAt: new Date().toISOString(),
  disarmedAt: null,
};

const matchedFamilies: MatchedFamilyView[] = [
  { family: "ORACLE_PRICE_STATE", matched: true, reason: "DRILL condition: Aave USDC oracle price 99979128 (8 decimals) <= 1.01 USD.", observationIds: [], values: {} },
  { family: "AAVE_RESERVE_STATE", matched: true, reason: "DRILL condition: Aave USDC reserve variable debt 6154634874505 > 0.", observationIds: [], values: {} },
  { family: "POSITION_STATE", matched: true, reason: "DRILL condition: protected aUSDC balance 5000065 > 0.", observationIds: [], values: {} },
];

const decisionRow = {
  id: DECISION_ID,
  positionId: POSITION_ID,
  policyId: policy.id,
  policyVersion: 1,
  state: "CONFIRMING",
  matchedCount: 3,
  contributingSignalIds: "[]",
  matchedFamiliesJson: '["ORACLE_PRICE_STATE","AAVE_RESERVE_STATE","POSITION_STATE"]',
  reasonJson: JSON.stringify(Object.fromEntries(matchedFamilies.map((m) => [m.family, m.reason]))),
  windowStartedAt: new Date(),
  confirmedAt: new Date(),
  expiresAt: new Date(Date.now() + 3_600_000),
  createdAt: new Date(),
  updatedAt: new Date(),
};

const executionRow = {
  id: EXECUTION_ID,
  decisionId: DECISION_ID,
  simulationId: null,
  status: "PROTECTED",
  chainId: 84532,
  target: `0x${"44".repeat(20)}`,
  function: "withdraw",
  parametersHash: "0x" + "ab".repeat(32),
  requestedAmount: "4999999",
  safeWallet: SAFE_WALLET,
  keeperhubExecutionId: "direct_evac_1",
  txHash: TX_HASH,
  blockNumber: "45384020",
  blockTimestamp: new Date(),
  submittedAt: new Date(),
  confirmedAt: new Date(),
  errorCode: null,
  errorDetailsJson: null,
  idempotencyKey: "ik-1",
  broadcastRequestHash: "0x" + "cd".repeat(32),
  lastKeeperHubStatus: "completed",
  transactionLink: `https://sepolia.basescan.org/tx/${TX_HASH}`,
  sponsored: true,
  submissionError: null,
  prePositionAmount: "5000077",
  preSafeWalletBalance: "0",
  preBlockNumber: "45384010",
  preBlockTimestamp: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

const receiptFacts = {
  id: RECEIPT_ID,
  status: "PROTECTED",
  verifiedAmount: "4999999",
  destination: SAFE_WALLET,
  txHash: TX_HASH,
  keeperhubExecutionId: "direct_evac_1",
  policyMode: "DRILL_HIGH_SENSITIVITY",
};

const seedSubscription = async (overrides: Partial<typeof telegramSubscriptions.$inferSelect> = {}) => {
  const [row] = await db
    .insert(telegramSubscriptions)
    .values({
      positionId: POSITION_ID,
      chatId: "42424242",
      telegramUsername: "vindex_user",
      riskAlertsEnabled: true,
      withdrawalAlertsEnabled: true,
      ...overrides,
    })
    .returning({ id: telegramSubscriptions.id });
  return row;
};

const seedPosition = async () => {
  await db.insert(protectedPositions).values(positionRow).onConflictDoNothing();
};

beforeAll(async () => {
  if (!dbAvailable) return;
  db = await getTestDb();
  await db.delete(notificationDeliveries);
  await db.delete(rescueReceipts);
  await db.delete(executions);
  await db.delete(threatDecisions);
  await db.delete(telegramSubscriptions);
  await db.delete(protectedPositions);
  await seedPosition();
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(() => {
  mockSend.mockClear();
});

describe("risk alert content", () => {
  it("uses real decision/policy/position records", () => {
    const message = buildRiskAlertMessage({ position: positionRow as never, policy, matchedFamilies });
    expect(message).toContain("⚠️ VINDEX RISK ALERT");
    expect(message).toContain("Pool: Aave V3 / Base Sepolia");
    expect(message).toContain("Protected position: USDC");
    expect(message).toContain("Protected wallet: 0x6756…d130");
    expect(message).toContain("Risk state: CONFIRMING");
    expect(message).toContain("Consensus: 3 / 2 signal families matched");
    expect(message).toContain("• Oracle Price State — DRILL condition: Aave USDC oracle price 99979128 (8 decimals) <= 1.01 USD.");
    expect(message).toContain("• Aave Reserve State — DRILL condition: Aave USDC reserve variable debt 6154634874505 > 0.");
    expect(message).toContain("• Position State — DRILL condition: protected aUSDC balance 5000065 > 0.");
    expect(message).toContain("Full-position Aave withdrawal → configured safe wallet");
    expect(message).toContain(SAFE_WALLET);
    expect(message).toContain("No funds have moved yet.");
    expect(message).toContain("Protection Drill:");
    expect(message).toContain("Not evidence of an Aave exploit.");
  });
});

describe("withdrawal alert content", () => {
  it("contains verified amounts, safe wallet, KeeperHub id, canonical tx link and drill line", () => {
    const message = buildWithdrawalAlertMessage({
      position: positionRow as never,
      receipt: receiptFacts as never,
      execution: executionRow as never,
      policyMode: "DRILL_HIGH_SENSITIVITY",
      policyLabel: "Protection Drill / High Sensitivity",
    });
    expect(message).toContain("✅ VINDEX POSITION PROTECTED");
    expect(message).toContain("PROTECTION DRILL — HIGH-SENSITIVITY POLICY");
    expect(message).toContain("Pool: Aave V3 / Base Sepolia");
    expect(message).toContain("Action: Full-position withdrawal");
    expect(message).toContain("Reason: Protection Drill / High Sensitivity");
    expect(message).toContain("Withdrawn:");
    expect(message).toContain("4.999999 USDC");
    expect(message).toContain("Verified received:");
    expect(message).toContain("4.999999 USDC");
    expect(message).toContain(`Safe wallet:\n${SAFE_WALLET}`);
    expect(message).toContain("KeeperHub execution:\ndirect_evac_1");
    expect(message).toContain(`Transaction:\nhttps://sepolia.basescan.org/tx/${TX_HASH}`);
    expect(message).toContain("Destination verified — PROTECTED");
  });

  it("omits the drill line for STANDARD policy mode", () => {
    const message = buildWithdrawalAlertMessage({
      position: positionRow as never,
      receipt: receiptFacts as never,
      execution: executionRow as never,
      policyMode: "STANDARD",
      policyLabel: "Standard",
    });
    expect(message).not.toContain("PROTECTION DRILL");
  });
});

describe("delivery behavior", () => {
  it.skipIf(!dbAvailable)("sends once per decision and deduplicates repeats", async () => {
    await seedSubscription();
    const first = await notifyRiskAlert({ db, positionId: POSITION_ID, decision: decisionRow as never, policy, matchedFamilies });
    const second = await notifyRiskAlert({ db, positionId: POSITION_ID, decision: decisionRow as never, policy, matchedFamilies });
    expect(first.delivered).toBe(true);
    expect(second.deduplicated).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.eventKey, `decision:${DECISION_ID}`));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("SENT");
    expect(rows[0].telegramMessageId).toBe("100");
  });

  it.skipIf(!dbAvailable)("disabled risk toggle suppresses the alert without a delivery row", async () => {
    const sub = await seedSubscription({ riskAlertsEnabled: false });
    const outcome = await notifyRiskAlert({ db, positionId: POSITION_ID, decision: decisionRow as never, policy, matchedFamilies });
    expect(outcome.delivered).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
    const rows = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.subscriptionId, sub.id));
    expect(rows).toHaveLength(0);
  });

  it.skipIf(!dbAvailable)("a disconnected subscription receives nothing", async () => {
    const sub = await seedSubscription({ disconnectedAt: new Date() });
    const outcome = await notifyRiskAlert({ db, positionId: POSITION_ID, decision: decisionRow as never, policy, matchedFamilies });
    expect(outcome.delivered).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
    const rows = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.subscriptionId, sub.id));
    expect(rows).toHaveLength(0);
  });

  it.skipIf(!dbAvailable)("withdrawal alert fires only when the receipt is PROTECTED", async () => {
    await seedSubscription();
    const notProtected = await notifyWithdrawalComplete({
      db,
      positionId: POSITION_ID,
      receipt: { ...receiptFacts, status: "UNVERIFIED" } as never,
      execution: executionRow as never,
      policyMode: "DRILL_HIGH_SENSITIVITY",
      policyLabel: "Protection Drill / High Sensitivity",
    });
    expect(notProtected.delivered).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();

    const protected_ = await notifyWithdrawalComplete({
      db,
      positionId: POSITION_ID,
      receipt: receiptFacts as never,
      execution: executionRow as never,
      policyMode: "DRILL_HIGH_SENSITIVITY",
      policyLabel: "Protection Drill / High Sensitivity",
    });
    expect(protected_.delivered).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const delivered = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.eventKey, `receipt:${RECEIPT_ID}`));
    expect(delivered).toHaveLength(1);
    expect(delivered[0].status).toBe("SENT");
  });

  it.skipIf(!dbAvailable)("duplicate receipts cannot duplicate the alert", async () => {
    await seedSubscription();
    const first = await notifyWithdrawalComplete({ db, positionId: POSITION_ID, receipt: receiptFacts as never, execution: executionRow as never, policyMode: "STANDARD", policyLabel: "Standard" });
    const second = await notifyWithdrawalComplete({ db, positionId: POSITION_ID, receipt: receiptFacts as never, execution: executionRow as never, policyMode: "STANDARD", policyLabel: "Standard" });
    expect(first.delivered).toBe(true);
    expect(second.deduplicated).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it.skipIf(!dbAvailable)("a failed send records FAILED + TELEGRAM_ALERT_FAILED audit and never throws", async () => {
    mockSend.mockResolvedValueOnce({ ok: false, messageId: null, errorCode: "TELEGRAM_HTTP_403" });
    await seedSubscription();
    const outcome = await notifyRiskAlert({ db, positionId: POSITION_ID, decision: decisionRow as never, policy, matchedFamilies });
    expect(outcome.failed).toBe(true);
    expect(outcome.errorCode).toBe("TELEGRAM_HTTP_403");
    const rows = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.eventKey, `decision:${DECISION_ID}`));
    expect(rows[0].status).toBe("FAILED");
    expect(rows[0].errorCode).toBe("TELEGRAM_HTTP_403");
    const audits = await db.select().from(auditEvents).where(eq(auditEvents.eventType, "TELEGRAM_ALERT_FAILED"));
    expect(audits.length).toBeGreaterThan(0);
  });

  it.skipIf(!dbAvailable)("a throwing transport never propagates and records a FAILED delivery", async () => {
    mockSend.mockRejectedValueOnce(new Error("boom"));
    await seedSubscription();
    const outcome = await notifyRiskAlert({ db, positionId: POSITION_ID, decision: decisionRow as never, policy, matchedFamilies });
    expect(outcome.failed).toBe(true);
  });

  it.skipIf(!dbAvailable)("test alert sends the fixed message with no fake incident", async () => {
    await seedSubscription();
    const outcome = await sendTestAlert({ db, positionId: POSITION_ID });
    expect(outcome.delivered).toBe(true);
    expect(mockSend.mock.calls[0][0].text).toBe("Vindex Telegram alerts are connected successfully.");
    const rows = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.eventType, "TEST"));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("SENT");
  });
});

describe("secret hygiene", () => {
  it.skipIf(!dbAvailable)("no delivery row or audit contains the bot token or webhook secret", async () => {
    await seedSubscription();
    await sendTestAlert({ db, positionId: POSITION_ID });
    const deliveries = await db.select().from(notificationDeliveries);
    const audits = await db.select().from(auditEvents);
    const serialized = JSON.stringify([deliveries, audits]);
    expect(serialized).not.toContain("bot_token");
    expect(serialized).not.toMatch(/123456789:AA/);
  });

  it("the service module never logs", async () => {
    const source = await readFile("lib/vindex/notification-service.ts", "utf8");
    expect(source).not.toMatch(/console\./);
  });
});
```

Note: `vi.mock` must come before the dynamic `import` of `sendTelegramMessage`; place `import { readFile } from "node:fs/promises";` at the top. Cleanup between tests: delete rows per `beforeEach` where a test seeds data with the same keys (dedup uses distinct eventKeys per test; `beforeEach` clears `notificationDeliveries` and `auditEvents` of telegram type only if needed — add `await db.delete(notificationDeliveries);` inside tests that assert counts).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- --run tests/unit/notification-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `lib/vindex/notification-service.ts`:

```ts
// P1 Telegram alert delivery. Observability ONLY: never throws, never alters
// the protection/withdrawal state machine, never retries chain actions.
// Exactly-once per (subscription, eventType, eventKey); TELEGRAM_BOT_TOKEN is
// read from env and never persisted or logged.

import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import type { VindexDb } from "../../db";
import {
  auditEvents,
  notificationDeliveries,
  protectedPositions,
  telegramSubscriptions,
} from "../../db/schema";
import type {
  ExecutionRow,
  ProtectedPositionRow,
  RescueReceiptRow,
  ThreatDecisionRow,
} from "../../db/schema";
import { sendTelegramMessage } from "../telegram/client";
import { buildBaseScanTxUrl } from "./basescan";
import { getTelegramEnv } from "./env";
import type { MatchedFamilyView, PolicyView } from "./policy-service";
import { DRILL_LABEL } from "./policy-templates";
import { formatFamilyLabel } from "../signal-family-labels";

export type NotificationEventType = "RISK_ALERT" | "WITHDRAWAL_COMPLETE" | "TEST";

export type NotificationOutcome = {
  delivered: boolean;
  deduplicated: boolean;
  failed: boolean;
  errorCode: string | null;
  eventType: NotificationEventType;
  eventKey: string;
};

// Structurally satisfied by both RescueReceiptRow and RescueReceiptView.
export type WithdrawalReceiptFacts = {
  id: string;
  status: string;
  verifiedAmount: string;
  destination: string;
  txHash: string;
  keeperhubExecutionId: string;
  policyMode: string;
};

const formatWallet = (address: string): string =>
  address.length >= 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

const fmtUsdc = (baseUnits: string): string => `${(Number(baseUnits) / 1_000_000).toFixed(6)} USDC`;

const POOL_LINE = "Pool: Aave V3 / Base Sepolia";

export const buildRiskAlertMessage = (params: {
  position: ProtectedPositionRow;
  policy: PolicyView;
  matchedFamilies: MatchedFamilyView[];
}): string => {
  const drill = params.policy.mode === "DRILL_HIGH_SENSITIVITY";
  const lines = [
    "⚠️ VINDEX RISK ALERT",
    "",
    POOL_LINE,
    `Protected position: ${params.position.assetSymbol}`,
    `Protected wallet: ${formatWallet(params.position.executionWallet)}`,
    "Risk state: CONFIRMING",
    `Consensus: ${params.matchedFamilies.length} / ${params.policy.requiredSignals} signal families matched`,
    "",
    "Why Vindex is acting:",
    ...params.matchedFamilies.map(
      (family) => `• ${formatFamilyLabel(family.family)} — ${family.reason}`,
    ),
    "",
    "Planned action:",
    "Full-position Aave withdrawal → configured safe wallet",
    "",
    "Safe wallet:",
    params.position.safeWallet ?? "Not configured",
    "",
    "No funds have moved yet.",
    "",
    drill
      ? "Protection Drill:\nHigh-sensitivity thresholds using real Base Sepolia measurements. Not evidence of an Aave exploit."
      : "Vindex will keep watching the protected position.",
  ];
  return lines.join("\n");
};

export const buildWithdrawalAlertMessage = (params: {
  position: ProtectedPositionRow;
  receipt: WithdrawalReceiptFacts;
  execution: ExecutionRow;
  policyMode: string;
  policyLabel: string;
}): string => {
  const drill = params.policyMode === "DRILL_HIGH_SENSITIVITY";
  const txUrl = buildBaseScanTxUrl(params.receipt.txHash);
  const lines = [
    "✅ VINDEX POSITION PROTECTED",
    ...(drill ? [DRILL_LABEL] : []),
    "",
    POOL_LINE,
    "Action: Full-position withdrawal",
    `Reason: ${params.policyLabel}`,
    "",
    "Withdrawn:",
    fmtUsdc(params.execution.requestedAmount),
    "",
    "Verified received:",
    fmtUsdc(params.receipt.verifiedAmount),
    "",
    "Safe wallet:",
    params.receipt.destination,
    "",
    "KeeperHub execution:",
    params.receipt.keeperhubExecutionId,
    "",
    "Transaction:",
    txUrl,
    "",
    "Status:",
    "Destination verified — PROTECTED",
  ];
  return lines.join("\n");
};

const getActiveSubscription = async (db: VindexDb, positionId: string) => {
  const rows = await db
    .select()
    .from(telegramSubscriptions)
    .where(
      and(
        eq(telegramSubscriptions.positionId, positionId),
        sql`${telegramSubscriptions.disconnectedAt} is null`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
};

const toggleEnabled = (
  eventType: NotificationEventType,
  subscription: { riskAlertsEnabled: boolean; withdrawalAlertsEnabled: boolean },
): boolean => {
  if (eventType === "RISK_ALERT") return subscription.riskAlertsEnabled;
  if (eventType === "WITHDRAWAL_COMPLETE") return subscription.withdrawalAlertsEnabled;
  return true; // TEST alerts always send when connected
};

export const deliverTelegramAlert = async (
  db: VindexDb,
  positionId: string,
  eventType: NotificationEventType,
  eventKey: string,
  buildMessage: () => string | null,
  options: { now?: () => Date } = {},
): Promise<NotificationOutcome> => {
  const now = options.now ?? (() => new Date());
  const failed = (errorCode: string): NotificationOutcome => ({
    delivered: false,
    deduplicated: false,
    failed: true,
    errorCode,
    eventType,
    eventKey,
  });
  try {
    const subscription = await getActiveSubscription(db, positionId);
    if (subscription === null) {
      return { delivered: false, deduplicated: false, failed: false, errorCode: null, eventType, eventKey };
    }
    if (!toggleEnabled(eventType, subscription)) {
      return { delivered: false, deduplicated: false, failed: false, errorCode: null, eventType, eventKey };
    }
    const existing = await db
      .select({ id: notificationDeliveries.id })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.subscriptionId, subscription.id),
          eq(notificationDeliveries.eventType, eventType),
          eq(notificationDeliveries.eventKey, eventKey),
        ),
      )
      .limit(1);
    if (existing[0] !== undefined) {
      return { delivered: false, deduplicated: true, failed: false, errorCode: null, eventType, eventKey };
    }
    const message = buildMessage();
    if (message === null) {
      return { delivered: false, deduplicated: false, failed: false, errorCode: null, eventType, eventKey };
    }
    const telegram = getTelegramEnv();
    if (telegram === null) {
      await recordDelivery(db, subscription.id, eventType, eventKey, "FAILED", null, "SERVER_NOT_CONFIGURED", now());
      return failed("SERVER_NOT_CONFIGURED");
    }
    const attemptedAt = now();
    const result = await sendTelegramMessage({
      botToken: telegram.botToken,
      chatId: subscription.chatId,
      text: message,
    });
    const errorCode = result.ok ? null : (result.errorCode ?? "TELEGRAM_ALERT_FAILED");
    const sentAt = result.ok ? now() : null;
    await recordDelivery(
      db,
      subscription.id,
      eventType,
      eventKey,
      result.ok ? "SENT" : "FAILED",
      result.messageId,
      errorCode,
      attemptedAt,
      sentAt,
    );
    if (!result.ok) {
      await db.insert(auditEvents).values({
        positionId,
        eventType: "TELEGRAM_ALERT_FAILED",
        detailsJson: JSON.stringify({ eventType, eventKey, errorCode }),
      });
    }
    return {
      delivered: result.ok,
      deduplicated: false,
      failed: !result.ok,
      errorCode,
      eventType,
      eventKey,
    };
  } catch (error) {
    return failed("TELEGRAM_ALERT_FAILED");
  }
};

const recordDelivery = async (
  db: VindexDb,
  subscriptionId: string,
  eventType: NotificationEventType,
  eventKey: string,
  status: "SENT" | "FAILED",
  telegramMessageId: string | null,
  errorCode: string | null,
  attemptedAt: Date,
  sentAt: Date | null = null,
): Promise<void> => {
  await db
    .insert(notificationDeliveries)
    .values({
      subscriptionId,
      eventType,
      eventKey,
      status,
      telegramMessageId,
      errorCode,
      attemptedAt,
      sentAt,
    })
    .onConflictDoNothing();
};

export const notifyRiskAlert = async (params: {
  db: VindexDb;
  positionId: string;
  decision: ThreatDecisionRow;
  policy: PolicyView;
  matchedFamilies: MatchedFamilyView[];
}): Promise<NotificationOutcome> => {
  const { db, positionId } = params;
  const eventKey = `decision:${params.decision.id}`;
  const positions = await db
    .select()
    .from(protectedPositions)
    .where(eq(protectedPositions.id, positionId))
    .limit(1);
  const position = positions[0];
  if (position === undefined) {
    return { delivered: false, deduplicated: false, failed: false, errorCode: null, eventType: "RISK_ALERT", eventKey };
  }
  return deliverTelegramAlert(db, positionId, "RISK_ALERT", eventKey, () =>
    buildRiskAlertMessage({ position, policy: params.policy, matchedFamilies: params.matchedFamilies }),
  );
};

export const notifyWithdrawalComplete = async (params: {
  db: VindexDb;
  positionId: string;
  receipt: WithdrawalReceiptFacts;
  execution: ExecutionRow;
  policyMode: string;
  policyLabel: string;
}): Promise<NotificationOutcome> => {
  const { db, positionId } = params;
  const eventKey = `receipt:${params.receipt.id}`;
  if (params.receipt.status !== "PROTECTED") {
    return { delivered: false, deduplicated: false, failed: false, errorCode: null, eventType: "WITHDRAWAL_COMPLETE", eventKey };
  }
  const positions = await db
    .select()
    .from(protectedPositions)
    .where(eq(protectedPositions.id, positionId))
    .limit(1);
  const position = positions[0];
  if (position === undefined) {
    return { delivered: false, deduplicated: false, failed: false, errorCode: null, eventType: "WITHDRAWAL_COMPLETE", eventKey };
  }
  return deliverTelegramAlert(db, positionId, "WITHDRAWAL_COMPLETE", eventKey, () =>
    buildWithdrawalAlertMessage({
      position,
      receipt: params.receipt,
      execution: params.execution,
      policyMode: params.policyMode,
      policyLabel: params.policyLabel,
    }),
  );
};

export const sendTestAlert = async (
  db: VindexDb,
  positionId: string,
  options: { now?: () => Date } = {},
): Promise<NotificationOutcome> =>
  deliverTelegramAlert(
    db,
    positionId,
    "TEST",
    `test:${randomUUID()}`,
    () => "Vindex Telegram alerts are connected successfully.",
    options,
  );
```

- [ ] **Step 4: Run the tests**

Run: `npm run test:unit -- --run tests/unit/notification-service.test.ts` — PASS. If `vi.mock` hoisting complains about the relative path, switch the mock path to `../../lib/telegram/client` consistently and hoist `vi.mock` to the top of imports (vitest hoists it automatically).

- [ ] **Step 5: Commit**

```bash
git add lib/vindex/notification-service.ts tests/unit/notification-service.test.ts
git commit -m "feat: exactly-once telegram delivery service with safe failures"
```

---

### Task 8: Hook alerts into the state machine (risk on CONFIRMING, withdrawal on PROTECTED)

**Files:**
- Modify: `lib/vindex/policy-service.ts` (inside `transitionToConfirming`, after the `CONFIRMATION_PASSED` audit, line ~635)
- Modify: `lib/vindex/verification-service.ts` (after the `POSITION_PROTECTED` audit, line ~634)
- Test: extend `tests/unit/policy-service.test.ts` and `tests/unit/verification-service.test.ts`

**Interfaces:**
- Consumes: `notifyRiskAlert`, `notifyWithdrawalComplete` (Task 7).

- [ ] **Step 1: Write the failing tests**

In `tests/unit/policy-service.test.ts`, add (reuse the existing `arm`, `seedDrillBaseline`, `makePassingReRead` helpers; the file already imports `protectedPositions`-related tables? — add the imports shown):

```ts
import {
  notificationDeliveries,
  protectedPositions,
  telegramSubscriptions,
} from "../../db/schema";
import { eq } from "drizzle-orm";
```

and inside `beforeAll` clear the new tables too:

```ts
await db.delete(notificationDeliveries);
await db.delete(telegramSubscriptions);
```

New describe block (uses the fake RPC/collect fakes that already exist in the file — the DRILL decision reaching CONFIRMING pattern from the existing test "two distinct families reach CONFIRMING with fresh re-read"):

```ts
describe("P1 risk alert hook", () => {
  it.skipIf(!dbAvailable)("a fresh confirmation sends exactly one risk alert", async () => {
    await db.delete(notificationDeliveries);
    await db.delete(telegramSubscriptions);
    await db
      .insert(protectedPositions)
      .values({
        id: POSITION_ID,
        chainId: 84532,
        protocol: "aave-v3",
        poolAddress: `0x${"11".repeat(20)}`,
        assetAddress: `0x${"22".repeat(20)}`,
        assetSymbol: "USDC",
        assetDecimals: 6,
        positionTokenAddress: `0x${"33".repeat(20)}`,
        executionWallet: WALLET,
        safeWallet: SAFE_WALLET,
        latestPositionAmount: "5000077",
        latestUnderlyingWalletBalance: "0",
        latestNativeBalanceWei: "20000000000000000",
        latestAllowance: "0",
        latestBlockNumber: "45384000",
        latestBlockTimestamp: new Date(),
        observedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
    await db.insert(telegramSubscriptions).values({
      positionId: POSITION_ID,
      chatId: "42424242",
      telegramUsername: "vindex_user",
      riskAlertsEnabled: true,
      withdrawalAlertsEnabled: true,
    });
    await arm("DRILL_HIGH_SENSITIVITY");
    const nowMs = now().getTime();
    await seedDrillBaseline(nowMs);
    const first = await evaluateProtectionPolicy({
      env: ENV,
      db,
      positionId: POSITION_ID,
      collect: makePassingReRead(),
      publicClient: createFakeRpc(),
      keeperHubClient: createFakeKeeperHub(),
      now,
    });
    expect(first.state).toBe("CONFIRMING");
    const rows = await db.select().from(notificationDeliveries);
    expect(rows.filter((r) => r.eventType === "RISK_ALERT")).toHaveLength(1);

    // A repeated evaluation must not alert again.
    const second = await evaluateProtectionPolicy({
      env: ENV,
      db,
      positionId: POSITION_ID,
      collect: makePassingReRead("2001"),
      publicClient: createFakeRpc(),
      keeperHubClient: createFakeKeeperHub(),
      now,
    });
    expect(second.state).toBe("CONFIRMING");
    const after = await db.select().from(notificationDeliveries);
    expect(after.filter((r) => r.eventType === "RISK_ALERT")).toHaveLength(1);
  });
});
```

In `tests/unit/verification-service.test.ts`, add a test asserting the withdrawal alert delivery row is created exactly once on the existing exact-delta-match success path (find the existing "an exact delta match creates the receipt and sets PROTECTED" test and assert after it):

```ts
import { notificationDeliveries, telegramSubscriptions } from "../../db/schema";
import { eq } from "drizzle-orm";

// inside the success-path test (or a new one that mirrors it):
it.skipIf(!dbAvailable)("P1: protection complete alert fires exactly once per receipt", async () => {
  // ... reuse the same setup as "an exact delta match creates the receipt and sets PROTECTED"
  // (seed execution + decision with the same fixtures, verified delta match) ...
  await db.insert(telegramSubscriptions).values({
    positionId,
    chatId: "42424242",
    riskAlertsEnabled: true,
    withdrawalAlertsEnabled: true,
  });
  const result = await verifyEvacuationDestination({ env: ENV, db, executionId, publicClient: createFakeRpc(), now });
  expect(result.outcome).toBe("VERIFIED");
  let rows = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.eventType, "WITHDRAWAL_COMPLETE"));
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("SENT");

  // Idempotent re-verify: no second delivery.
  await verifyEvacuationDestination({ env: ENV, db, executionId, publicClient: createFakeRpc(), now });
  rows = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.eventType, "WITHDRAWAL_COMPLETE"));
  expect(rows).toHaveLength(1);
});
```

(Follow the existing test's seeding exactly — the verification test file already builds `executionId`, `positionId`, `ENV`, `createFakeRpc`, `now` fixtures; copy its arrangement.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- --run tests/unit/policy-service.test.ts tests/unit/verification-service.test.ts`
Expected: FAIL — no delivery rows created.

- [ ] **Step 3: Hook the risk alert into `policy-service.ts`**

Add import at the top:

```ts
import { notifyRiskAlert } from "./notification-service";
```

Inside `transitionToConfirming`, immediately after the `CONFIRMATION_PASSED` `writeAudit` call and before the `return {` (currently line ~635):

```ts
// P1: best-effort risk alert — exactly once per decision (dedup by eventKey).
void notifyRiskAlert({ db, positionId, decision, policy, matchedFamilies: matchedFamiliesView });
```

`decision` (ThreatDecisionRow), `policy` (PolicyView) and `matchedFamiliesView` are already in scope.

- [ ] **Step 4: Hook the withdrawal alert into `verification-service.ts`**

Add import:

```ts
import { notifyWithdrawalComplete } from "./notification-service";
```

Immediately after the `POSITION_PROTECTED` `writeAudit` (line ~634), before `return {`:

```ts
// P1: best-effort protection-complete alert — only after destination
// verification passes and the receipt exists (PROTECTED). Never blocks.
void notifyWithdrawalComplete({
  db,
  positionId,
  receipt: { ...receipt, policyMode: policy?.mode ?? "DRILL_HIGH_SENSITIVITY" },
  execution,
  policyMode: policy?.mode ?? "DRILL_HIGH_SENSITIVITY",
  policyLabel:
    policy?.mode === "DRILL_HIGH_SENSITIVITY"
      ? "Protection Drill / High Sensitivity"
      : "Standard",
});
```

(`receipt` is a `RescueReceiptView`; the spread adds `policyMode` so it structurally matches `WithdrawalReceiptFacts`.)

- [ ] **Step 5: Run the tests**

Run: `npm run test:unit -- --run tests/unit/policy-service.test.ts tests/unit/verification-service.test.ts` — PASS (with `DATABASE_URL` present).

- [ ] **Step 6: Commit**

```bash
git add lib/vindex/policy-service.ts lib/vindex/verification-service.ts tests/unit/policy-service.test.ts tests/unit/verification-service.test.ts
git commit -m "feat: risk and protection-complete alerts on real state transitions"
```

---

### Task 9: Connect tokens + Telegram webhook route

**Files:**
- Create: `lib/vindex/telegram-connect.ts`, `app/api/integrations/telegram/webhook/route.ts`
- Modify: `vitest.config.ts` (add the `@` path alias so route-handler tests resolve `@/db` and `@/lib/...` imports)
- Test: `tests/unit/telegram-webhook.test.ts`

**Interfaces:**
- Consumes: `getTelegramEnv` (Task 2), `sendTelegramMessage` (Task 6), Task 1 tables.
- Produces:
  - `hashConnectToken(token: string): string` (sha256 hex)
  - `createConnectToken(db, positionId, now?): Promise<{ token: string; expiresAt: Date }>` — stores hash only, 15-min TTL
  - `consumeConnectToken(db, rawToken, chatId, username, now?): Promise<"OK" | "INVALID" | "EXPIRED" | "CONSUMED">` — retires other active subscriptions for the position and upserts/rebinds `(positionId, chatId)`, consuming the token in the same transaction
  - `isSecretMatch(provided: string | null, expected: string): boolean` — timing-safe
  - Route `POST /api/integrations/telegram/webhook` — validates `X-Telegram-Bot-Api-Secret-Token`, handles `/start <token>`, always responds promptly.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/telegram-webhook.test.ts`:

```ts
// P1 Telegram connection: one-time short-lived tokens (hash-only storage),
// webhook secret enforcement, and /start binding the correct subscription.

import { describe, expect, it, vi, afterAll, beforeAll } from "vitest";

import { eq } from "drizzle-orm";

import {
  telegramConnectTokens,
  telegramSubscriptions,
} from "../../db/schema";
import {
  consumeConnectToken,
  createConnectToken,
  hashConnectToken,
  isSecretMatch,
} from "../../lib/vindex/telegram-connect";
import { closeTestDb, getTestDb } from "./helpers/test-db";

vi.mock("../../lib/telegram/client", () => ({
  sendTelegramMessage: vi.fn(async () => ({ ok: true, messageId: "1", errorCode: null })),
}));

import { POST } from "../../app/api/integrations/telegram/webhook/route";

const dbAvailable = Boolean(process.env.DATABASE_URL?.trim());
let db: Awaited<ReturnType<typeof getTestDb>>;

const WALLET = "0x675638ddbbf8b70b906d68e3485da72c6c63d130";
const POSITION_ID = `base-sepolia:aave-v3:usdc:${WALLET}`;
const CHAT_ID = "42424242";
const SECRET = "super-secret-webhook-secret";

beforeAll(async () => {
  if (!dbAvailable) return;
  db = await getTestDb();
  await db.delete(telegramSubscriptions);
  await db.delete(telegramConnectTokens);
});

afterAll(async () => {
  await closeTestDb();
});

const webhookRequest = (body: unknown, secret: string | null = SECRET) =>
  new Request("https://vindex.local/api/integrations/telegram/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret !== null ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {}),
    },
    body: JSON.stringify(body),
  });

describe("connect tokens", () => {
  it.skipIf(!dbAvailable)("persists only the hash, never the raw token", async () => {
    const { token } = await createConnectToken(db, POSITION_ID);
    const rows = await db.select().from(telegramConnectTokens);
    expect(rows[0].tokenHash).toBe(hashConnectToken(token));
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(token);
  });

  it.skipIf(!dbAvailable)("expired tokens fail safely", async () => {
    const { token } = await createConnectToken(db, POSITION_ID, () => new Date(Date.now() - 30 * 60 * 1000));
    const result = await consumeConnectToken(db, token, CHAT_ID, "user", () => new Date());
    expect(result).toBe("EXPIRED");
    const subs = await db.select().from(telegramSubscriptions);
    expect(subs).toHaveLength(0);
  });

  it.skipIf(!dbAvailable)("tokens are one-time", async () => {
    const { token } = await createConnectToken(db, POSITION_ID);
    expect(await consumeConnectToken(db, token, CHAT_ID, "user", () => new Date())).toBe("OK");
    expect(await consumeConnectToken(db, token, CHAT_ID, "user", () => new Date())).toBe("CONSUMED");
    const subs = await db.select().from(telegramSubscriptions);
    expect(subs).toHaveLength(1);
    expect(subs[0].chatId).toBe(CHAT_ID);
    expect(subs[0].telegramUsername).toBe("user");
  });

  it.skipIf(!dbAvailable)("wrong tokens fail safely", async () => {
    const result = await consumeConnectToken(db, "not-a-real-token", CHAT_ID, "user", () => new Date());
    expect(result).toBe("INVALID");
  });
});

describe("webhook route", () => {
  it("requires the webhook secret header", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:abc");
    vi.stubEnv("TELEGRAM_BOT_USERNAME", "VindexAlertsBot");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    try {
      const missing = await POST(webhookRequest({}, null));
      expect(missing.status).toBe(403);
      const wrong = await POST(webhookRequest({}, "wrong-secret"));
      expect(wrong.status).toBe(403);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.skipIf(!dbAvailable)("binds the subscription from /start <token>", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:abc");
    vi.stubEnv("TELEGRAM_BOT_USERNAME", "VindexAlertsBot");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    try {
      const { token } = await createConnectToken(db, POSITION_ID);
      const response = await POST(
        webhookRequest({
          message: {
            chat: { id: CHAT_ID },
            text: `/start ${token}`,
            from: { username: "vindex_user" },
          },
        }),
      );
      expect(response.status).toBe(200);
      const subs = await db.select().from(telegramSubscriptions);
      expect(subs).toHaveLength(1);
      expect(subs[0].positionId).toBe(POSITION_ID);
      expect(subs[0].chatId).toBe(CHAT_ID);
      expect(subs[0].telegramUsername).toBe("vindex_user");
      const tokens = await db.select().from(telegramConnectTokens).where(eq(telegramConnectTokens.tokenHash, hashConnectToken(token)));
      expect(tokens[0].consumedAt).not.toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.skipIf(!dbAvailable)("a second /start with the same token cannot rebind", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:abc");
    vi.stubEnv("TELEGRAM_BOT_USERNAME", "VindexAlertsBot");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    try {
      const { token } = await createConnectToken(db, POSITION_ID);
      await POST(webhookRequest({ message: { chat: { id: CHAT_ID }, text: `/start ${token}` } }));
      const second = await POST(webhookRequest({ message: { chat: { id: "99999" }, text: `/start ${token}` } }));
      expect(second.status).toBe(200);
      const subs = await db.select().from(telegramSubscriptions);
      expect(subs).toHaveLength(1);
      expect(subs[0].chatId).toBe(CHAT_ID);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("secret match", () => {
  it("is timing-safe and rejects null/mismatch", () => {
    expect(isSecretMatch(SECRET, SECRET)).toBe(true);
    expect(isSecretMatch("x", SECRET)).toBe(false);
    expect(isSecretMatch(null, SECRET)).toBe(false);
    expect(isSecretMatch("", SECRET)).toBe(false);
  });
});
```

Note: `vi.stubEnv` + route module read `getTelegramEnv()` at request time — that works since `getTelegramEnv` reads `process.env` on every call.

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:unit -- --run tests/unit/telegram-webhook.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `lib/vindex/telegram-connect.ts`**

```ts
// P1 Telegram Bot-API deep-link connection. One-time short-lived tokens; only
// sha256 hashes are persisted. The raw token is never stored or logged.

import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";

import type { VindexDb } from "../../db";
import { telegramConnectTokens, telegramSubscriptions } from "../../db/schema";

export const CONNECT_TOKEN_TTL_MS = 15 * 60 * 1000;

export const hashConnectToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export const createConnectToken = async (
  db: VindexDb,
  positionId: string,
  now: () => Date = () => new Date(),
): Promise<{ token: string; expiresAt: Date }> => {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now().getTime() + CONNECT_TOKEN_TTL_MS);
  await db.insert(telegramConnectTokens).values({
    tokenHash: hashConnectToken(token),
    positionId,
    expiresAt,
  });
  return { token, expiresAt };
};

export type ConnectConsumeResult = "OK" | "INVALID" | "EXPIRED" | "CONSUMED";

export const consumeConnectToken = async (
  db: VindexDb,
  rawToken: string,
  chatId: string,
  username: string | null,
  now: () => Date = () => new Date(),
): Promise<ConnectConsumeResult> => {
  const rows = await db
    .select()
    .from(telegramConnectTokens)
    .where(eq(telegramConnectTokens.tokenHash, hashConnectToken(rawToken)))
    .limit(1);
  const token = rows[0];
  if (token === undefined) return "INVALID";
  if (token.consumedAt !== null) return "CONSUMED";
  if (token.expiresAt.getTime() <= now().getTime()) return "EXPIRED";

  await db.transaction(async (tx) => {
    await tx
      .update(telegramConnectTokens)
      .set({ consumedAt: now() })
      .where(and(eq(telegramConnectTokens.id, token.id), isNull(telegramConnectTokens.consumedAt)));
    // Retire any other active subscription for this position; the new chat takes over.
    await tx
      .update(telegramSubscriptions)
      .set({ disconnectedAt: now() })
      .where(
        and(
          eq(telegramSubscriptions.positionId, token.positionId),
          sql`${telegramSubscriptions.disconnectedAt} is null`,
          sql`${telegramSubscriptions.chatId} <> ${chatId}`,
        ),
      );
    await tx
      .insert(telegramSubscriptions)
      .values({
        positionId: token.positionId,
        chatId,
        telegramUsername: username,
        riskAlertsEnabled: true,
        withdrawalAlertsEnabled: true,
        connectedAt: now(),
        disconnectedAt: null,
      })
      .onConflictDoUpdate({
        target: [telegramSubscriptions.positionId, telegramSubscriptions.chatId],
        set: {
          telegramUsername: username,
          disconnectedAt: null,
          connectedAt: now(),
          updatedAt: now(),
        },
      });
  });
  return "OK";
};

export const isSecretMatch = (provided: string | null, expected: string): boolean => {
  if (provided === null) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};
```

- [ ] **Step 5: Implement the webhook route**

Create `app/api/integrations/telegram/webhook/route.ts`:

```ts
import { getDb } from "@/db";
import { sendTelegramMessage } from "@/lib/telegram/client";
import { getTelegramEnv } from "@/lib/vindex/env";
import {
  consumeConnectToken,
  isSecretMatch,
} from "@/lib/vindex/telegram-connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TelegramUpdate = {
  message?: { chat: { id: number | string }; text?: string; from?: { username?: string } };
  edited_message?: { chat: { id: number | string }; text?: string; from?: { username?: string } };
};

// Bot API webhook: only the /start <token> deep-link flow is handled. Telegram
// is observability only — no command can ever approve or trigger anything.
export async function POST(request: Request) {
  const telegram = getTelegramEnv();
  if (telegram === null) {
    return Response.json(
      { error: "SERVER_NOT_CONFIGURED", message: "Telegram is not configured." },
      { status: 503 },
    );
  }
  const header = request.headers.get("x-telegram-bot-api-secret-token");
  if (!isSecretMatch(header, telegram.webhookSecret)) {
    return Response.json({ error: "UNAUTHORIZED", message: "Invalid webhook secret." }, { status: 403 });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return Response.json({ error: "BAD_REQUEST", message: "Invalid JSON payload." }, { status: 400 });
  }

  const message = update.message ?? update.edited_message;
  const text = message?.text ?? "";
  const chatId = message?.chat?.id;
  if (chatId === undefined || (typeof chatId !== "number" && typeof chatId !== "string")) {
    return Response.json({ ok: false, reason: "NO_CHAT" });
  }

  // Anything that is not /start <token> is ignored (and never retried).
  const match = text.match(/^\/start(?:\s+([A-Za-z0-9_-]+))?$/);
  if (match === null) {
    return Response.json({ ok: true, reason: "IGNORED" });
  }
  const rawToken = match[1] ?? "";
  if (rawToken === "") {
    return Response.json({ ok: false, reason: "NO_TOKEN" });
  }

  const result = await consumeConnectToken(
    getDb(),
    rawToken,
    String(chatId),
    message?.from?.username ?? null,
  );
  if (result !== "OK") {
    // Expired/consumed/wrong tokens fail safely — the caller learns nothing extra.
    return Response.json({ ok: false, reason: result === "INVALID" ? "INVALID_TOKEN" : result });
  }

  await sendTelegramMessage({
    botToken: telegram.botToken,
    chatId: String(chatId),
    text: "Vindex Telegram alerts are connected successfully.",
  });
  return Response.json({ ok: true });
}
```

- [ ] **Step 5: Run the tests**

Run: `npm run test:unit -- --run tests/unit/telegram-webhook.test.ts` — PASS.
Run: `npm run lint` and `npm run typecheck` — PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/vindex/telegram-connect.ts app/api/integrations/telegram/webhook/route.ts tests/unit/telegram-webhook.test.ts
git commit -m "feat: one-time connect tokens and Telegram /start webhook"
```

---

### Task 10: Telegram API routes (status / toggles / disconnect / connect / test)

**Files:**
- Create: `lib/vindex/telegram-service.ts`, `app/api/vindex/telegram/route.ts`, `app/api/vindex/telegram/connect/route.ts`, `app/api/vindex/telegram/test/route.ts`
- Test: `tests/unit/telegram-routes.test.ts`

**Interfaces:**
- Consumes: Task 1 tables, `createConnectToken` (Task 9), `getTelegramEnv` (Task 2), `sendTestAlert` (Task 7), `canonicalPositionId` + `createKeeperHubClient` (existing patterns from `app/api/vindex/decisions/current/route.ts`).
- Produces:
  - `getTelegramStatus(db, positionId): Promise<TelegramStatusView>` where
    `TelegramStatusView = { connected: boolean; telegramUsername: string | null; chatMasked: string | null; riskAlertsEnabled: boolean; withdrawalAlertsEnabled: boolean; lastDelivery: { eventType: string; status: string; errorCode: string | null; attemptedAt: string } | null }`
  - `updateTelegramToggles(db, positionId, { riskAlertsEnabled?: boolean; withdrawalAlertsEnabled?: boolean }): Promise<TelegramStatusView>`
  - `disconnectTelegram(db, positionId): Promise<{ connected: false }>`
  - Routes:
    - `GET /api/vindex/telegram` → status view
    - `PATCH /api/vindex/telegram` → toggles, returns status view
    - `DELETE /api/vindex/telegram` → disconnect, returns `{ connected: false }`
    - `POST /api/vindex/telegram/connect` → `{ token, botUsername, connectUrl, expiresAt }` (503 `SERVER_NOT_CONFIGURED` when Telegram env missing)
    - `POST /api/vindex/telegram/test` → `{ outcome }` of `sendTestAlert`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/telegram-routes.test.ts`:

```ts
// P1 Telegram settings API: status from the DB, toggles, disconnect, connect
// token issuance (hash-only storage) and the test alert.

import { describe, expect, it, vi, afterAll, beforeAll } from "vitest";

import { eq } from "drizzle-orm";

import { telegramConnectTokens, telegramSubscriptions } from "../../db/schema";
import { getTelegramStatus, updateTelegramToggles, disconnectTelegram } from "../../lib/vindex/telegram-service";
import { hashConnectToken } from "../../lib/vindex/telegram-connect";
import { closeTestDb, getTestDb } from "./helpers/test-db";

vi.mock("../../lib/telegram/client", () => ({
  sendTelegramMessage: vi.fn(async () => ({ ok: true, messageId: "7", errorCode: null })),
}));

import { GET as statusGET, PATCH, DELETE } from "../../app/api/vindex/telegram/route";
import { POST as connectPOST } from "../../app/api/vindex/telegram/connect/route";
import { POST as testPOST } from "../../app/api/vindex/telegram/test/route";

const dbAvailable = Boolean(process.env.DATABASE_URL?.trim());
let db: Awaited<ReturnType<typeof getTestDb>>;

const WALLET = "0x675638ddbbf8b70b906d68e3485da72c6c63d130";
const POSITION_ID = `base-sepolia:aave-v3:usdc:${WALLET}`;

beforeAll(async () => {
  if (!dbAvailable) return;
  db = await getTestDb();
  await db.delete(telegramSubscriptions);
  await db.delete(telegramConnectTokens);
});

afterAll(async () => {
  await closeTestDb();
});

describe("telegram service views", () => {
  it.skipIf(!dbAvailable)("reports disconnected before any subscription", async () => {
    const status = await getTelegramStatus(db, POSITION_ID);
    expect(status).toEqual({
      connected: false,
      telegramUsername: null,
      chatMasked: null,
      riskAlertsEnabled: true,
      withdrawalAlertsEnabled: true,
      lastDelivery: null,
    });
  });

  it.skipIf(!dbAvailable)("reports connected with DB-backed identity", async () => {
    await db.insert(telegramSubscriptions).values({
      positionId: POSITION_ID,
      chatId: "42424242",
      telegramUsername: "vindex_user",
      riskAlertsEnabled: true,
      withdrawalAlertsEnabled: false,
    });
    const status = await getTelegramStatus(db, POSITION_ID);
    expect(status.connected).toBe(true);
    expect(status.telegramUsername).toBe("vindex_user");
    expect(status.withdrawalAlertsEnabled).toBe(false);
    expect(status.chatMasked).toBeTruthy();
  });

  it.skipIf(!dbAvailable)("toggles persist to the subscription row", async () => {
    const updated = await updateTelegramToggles(db, POSITION_ID, { riskAlertsEnabled: false });
    expect(updated.riskAlertsEnabled).toBe(false);
    const rows = await db.select().from(telegramSubscriptions).where(eq(telegramSubscriptions.positionId, POSITION_ID));
    expect(rows[0].riskAlertsEnabled).toBe(false);
  });

  it.skipIf(!dbAvailable)("disconnect soft-removes the subscription", async () => {
    await disconnectTelegram(db, POSITION_ID);
    const status = await getTelegramStatus(db, POSITION_ID);
    expect(status.connected).toBe(false);
  });
});

describe("telegram routes", () => {
  it("connect issues a token and returns the deep link", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:abc");
    vi.stubEnv("TELEGRAM_BOT_USERNAME", "VindexAlertsBot");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "secret");
    try {
      const response = await connectPOST(new Request("https://vindex.local/api/vindex/telegram/connect", { method: "POST", body: "{}" }));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { token: string; botUsername: string; connectUrl: string; expiresAt: string };
      expect(body.botUsername).toBe("VindexAlertsBot");
      expect(body.connectUrl).toBe(`https://t.me/VindexAlertsBot?start=${body.token}`);
      expect(body.token).toBeTruthy();
      expect(body.expiresAt).toBeTruthy();
      const rows = await db.select().from(telegramConnectTokens);
      expect(rows[0].tokenHash).toBe(hashConnectToken(body.token));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("connect returns 503 SERVER_NOT_CONFIGURED without Telegram env", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    vi.stubEnv("TELEGRAM_BOT_USERNAME", "");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "");
    try {
      const response = await connectPOST(new Request("https://vindex.local/api/vindex/telegram/connect", { method: "POST", body: "{}" }));
      expect(response.status).toBe(503);
      expect((await response.json()).error).toBe("SERVER_NOT_CONFIGURED");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
```

Note: route tests for `GET /api/vindex/telegram` require KeeperHub + org wallet (the route resolves positionId via `createKeeperHubClient`). Keep route-level status tests out of unit scope — the service-level tests above cover status semantics; the route behavior for connect (env-gated) is tested directly.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- --run tests/unit/telegram-routes.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `lib/vindex/telegram-service.ts`**

```ts
// P1 Telegram settings views: connection status, toggles, soft disconnect.
// All state lives in the database — the UI never stores connection state.

import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import type { VindexDb } from "../../db";
import { notificationDeliveries, telegramSubscriptions } from "../../db/schema";

export type TelegramStatusView = {
  connected: boolean;
  telegramUsername: string | null;
  chatMasked: string | null;
  riskAlertsEnabled: boolean;
  withdrawalAlertsEnabled: boolean;
  lastDelivery: {
    eventType: string;
    status: string;
    errorCode: string | null;
    attemptedAt: string;
  } | null;
};

export const getTelegramStatus = async (
  db: VindexDb,
  positionId: string,
): Promise<TelegramStatusView> => {
  const rows = await db
    .select()
    .from(telegramSubscriptions)
    .where(
      and(
        eq(telegramSubscriptions.positionId, positionId),
        sql`${telegramSubscriptions.disconnectedAt} is null`,
      ),
    )
    .limit(1);
  const subscription = rows[0] ?? null;
  let lastDelivery: TelegramStatusView["lastDelivery"] = null;
  if (subscription !== null) {
    const deliveries = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.subscriptionId, subscription.id))
      .orderBy(desc(notificationDeliveries.attemptedAt))
      .limit(1);
    const latest = deliveries[0];
    if (latest !== undefined) {
      lastDelivery = {
        eventType: latest.eventType,
        status: latest.status,
        errorCode: latest.errorCode,
        attemptedAt: latest.attemptedAt.toISOString(),
      };
    }
  }
  return {
    connected: subscription !== null,
    telegramUsername: subscription?.telegramUsername ?? null,
    chatMasked:
      subscription !== null && subscription.telegramUsername === null
        ? `${String(subscription.chatId).slice(0, 2)}…${String(subscription.chatId).slice(-4)}`
        : null,
    riskAlertsEnabled: subscription?.riskAlertsEnabled ?? true,
    withdrawalAlertsEnabled: subscription?.withdrawalAlertsEnabled ?? true,
    lastDelivery,
  };
};

export const updateTelegramToggles = async (
  db: VindexDb,
  positionId: string,
  toggles: { riskAlertsEnabled?: boolean; withdrawalAlertsEnabled?: boolean },
): Promise<TelegramStatusView> => {
  const rows = await db
    .select()
    .from(telegramSubscriptions)
    .where(
      and(
        eq(telegramSubscriptions.positionId, positionId),
        sql`${telegramSubscriptions.disconnectedAt} is null`,
      ),
    )
    .limit(1);
  const subscription = rows[0];
  if (subscription === undefined) {
    return getTelegramStatus(db, positionId);
  }
  await db
    .update(telegramSubscriptions)
    .set({
      ...(toggles.riskAlertsEnabled !== undefined ? { riskAlertsEnabled: toggles.riskAlertsEnabled } : {}),
      ...(toggles.withdrawalAlertsEnabled !== undefined ? { withdrawalAlertsEnabled: toggles.withdrawalAlertsEnabled } : {}),
      updatedAt: new Date(),
    })
    .where(eq(telegramSubscriptions.id, subscription.id));
  return getTelegramStatus(db, positionId);
};

export const disconnectTelegram = async (
  db: VindexDb,
  positionId: string,
): Promise<{ connected: false }> => {
  await db
    .update(telegramSubscriptions)
    .set({ disconnectedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(telegramSubscriptions.positionId, positionId),
        sql`${telegramSubscriptions.disconnectedAt} is null`,
      ),
    );
  return { connected: false };
};
```

- [ ] **Step 4: Implement the routes**

Create `app/api/vindex/telegram/route.ts`:

```ts
import { getDb } from "@/db";
import { getServerEnv, VindexEnvError } from "@/lib/vindex/env";
import { toApiErrorResponse } from "@/lib/vindex/errors";
import { createKeeperHubClient } from "@/lib/vindex/keeperhub";
import { canonicalPositionId } from "@/lib/vindex/position-service";
import {
  disconnectTelegram,
  getTelegramStatus,
  updateTelegramToggles,
} from "@/lib/vindex/telegram-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const resolvePositionId = async () => {
  const env = getServerEnv();
  const client = createKeeperHubClient({ apiKey: env.keeperhubApiKey, baseUrl: env.keeperhubApiBaseUrl });
  const wallet = await client.getOrganizationWallet();
  if (!wallet.hasWallet || wallet.walletAddress === null) {
    throw Object.assign(new Error("KeeperHub organization wallet is not configured."), { code: "KEEPERHUB_UNAVAILABLE", status: 422 });
  }
  return canonicalPositionId(wallet.walletAddress);
};

const withEnv = async <T>(fn: () => Promise<T>): Promise<Response> => {
  try {
    return Response.json(await fn());
  } catch (error) {
    if (error instanceof VindexEnvError) {
      return Response.json({ error: "SERVER_NOT_CONFIGURED", message: error.message }, { status: 503 });
    }
    return toApiErrorResponse(error);
  }
};

export async function GET() {
  return withEnv(async () => getTelegramStatus(getDb(), await resolvePositionId()));
}

export async function PATCH(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "BAD_REQUEST", message: "Request body must be valid JSON." }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ error: "BAD_REQUEST", message: "Request body must be a JSON object." }, { status: 400 });
  }
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.some((key) => key !== "riskAlertsEnabled" && key !== "withdrawalAlertsEnabled")) {
    return Response.json(
      { error: "UNKNOWN_FIELD", message: "Only riskAlertsEnabled and withdrawalAlertsEnabled are accepted." },
      { status: 400 },
    );
  }
  const record = body as Record<string, unknown>;
  const toggles: { riskAlertsEnabled?: boolean; withdrawalAlertsEnabled?: boolean } = {};
  for (const key of ["riskAlertsEnabled", "withdrawalAlertsEnabled"] as const) {
    if (record[key] !== undefined) {
      if (typeof record[key] !== "boolean") {
        return Response.json({ error: "BAD_REQUEST", message: `${key} must be a boolean.` }, { status: 400 });
      }
      toggles[key] = record[key];
    }
  }
  return withEnv(async () =>
    updateTelegramToggles(getDb(), await resolvePositionId(), toggles),
  );
}

export async function DELETE() {
  return withEnv(async () => disconnectTelegram(getDb(), await resolvePositionId()));
}
```

Create `app/api/vindex/telegram/connect/route.ts`:

```ts
import { getDb } from "@/db";
import { getTelegramEnv, getServerEnv, VindexEnvError } from "@/lib/vindex/env";
import { toApiErrorResponse } from "@/lib/vindex/errors";
import { createKeeperHubClient } from "@/lib/vindex/keeperhub";
import { canonicalPositionId } from "@/lib/vindex/position-service";
import { createConnectToken } from "@/lib/vindex/telegram-connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  let env;
  try {
    env = getServerEnv();
  } catch (error) {
    if (error instanceof VindexEnvError) {
      return Response.json({ error: "SERVER_NOT_CONFIGURED", message: error.message }, { status: 503 });
    }
    return Response.json({ error: "SERVER_NOT_CONFIGURED", message: "Server not configured." }, { status: 503 });
  }
  const telegram = getTelegramEnv();
  if (telegram === null) {
    return Response.json(
      { error: "SERVER_NOT_CONFIGURED", message: "Telegram is not configured. Set TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME and TELEGRAM_WEBHOOK_SECRET." },
      { status: 503 },
    );
  }
  try {
    const client = createKeeperHubClient({ apiKey: env.keeperhubApiKey, baseUrl: env.keeperhubApiBaseUrl });
    const wallet = await client.getOrganizationWallet();
    if (!wallet.hasWallet || wallet.walletAddress === null) {
      return Response.json(
        { error: "KEEPERHUB_UNAVAILABLE", message: "KeeperHub organization wallet is not configured." },
        { status: 422 },
      );
    }
    const positionId = canonicalPositionId(wallet.walletAddress);
    const { token, expiresAt } = await createConnectToken(getDb(), positionId);
    return Response.json({
      token,
      botUsername: telegram.botUsername,
      connectUrl: `https://t.me/${telegram.botUsername}?start=${token}`,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
```

Create `app/api/vindex/telegram/test/route.ts`:

```ts
import { getDb } from "@/db";
import { getServerEnv, VindexEnvError } from "@/lib/vindex/env";
import { toApiErrorResponse } from "@/lib/vindex/errors";
import { createKeeperHubClient } from "@/lib/vindex/keeperhub";
import { sendTestAlert } from "@/lib/vindex/notification-service";
import { canonicalPositionId } from "@/lib/vindex/position-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  let env;
  try {
    env = getServerEnv();
  } catch (error) {
    if (error instanceof VindexEnvError) {
      return Response.json({ error: "SERVER_NOT_CONFIGURED", message: error.message }, { status: 503 });
    }
    return Response.json({ error: "SERVER_NOT_CONFIGURED", message: "Server not configured." }, { status: 503 });
  }
  try {
    const client = createKeeperHubClient({ apiKey: env.keeperhubApiKey, baseUrl: env.keeperhubApiBaseUrl });
    const wallet = await client.getOrganizationWallet();
    if (!wallet.hasWallet || wallet.walletAddress === null) {
      return Response.json(
        { error: "KEEPERHUB_UNAVAILABLE", message: "KeeperHub organization wallet is not configured." },
        { status: 422 },
      );
    }
    const positionId = canonicalPositionId(wallet.walletAddress);
    const outcome = await sendTestAlert(getDb(), positionId);
    if (outcome.delivered) {
      return Response.json({ outcome });
    }
    if (outcome.deduplicated) {
      return Response.json({ error: "IDEMPOTENCY_CONFLICT", message: "A test alert was already delivered." }, { status: 409 });
    }
    return Response.json({ error: "TELEGRAM_ALERT_FAILED", message: "The test alert could not be delivered." }, { status: 502 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npm run test:unit -- --run tests/unit/telegram-routes.test.ts` — PASS.
Run: `npm run lint` and `npm run typecheck` — PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/vindex/telegram-service.ts app/api/vindex/telegram/route.ts app/api/vindex/telegram/connect/route.ts app/api/vindex/telegram/test/route.ts tests/unit/telegram-routes.test.ts
git commit -m "feat: telegram settings API routes (status, toggles, connect, test, disconnect)"
```

---

### Task 11: Settings UI — Telegram Alerts section

**Files:**
- Create: `components/forms/telegram-settings.tsx`
- Modify: `app/(product)/settings/page.tsx`, `app/globals.css`
- Test: extend `tests/unit/telegram-routes.test.ts` (status states) + new `tests/unit/telegram-settings-copy.test.ts` (pure copy mapping)

**Interfaces:**
- Consumes: `GET/PATCH/DELETE /api/vindex/telegram`, `POST /api/vindex/telegram/connect`, `POST /api/vindex/telegram/test` (Task 10).
- Produces: `TelegramSettings` client component; exported pure `telegramConnectionCopy(status)` used by tests.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/telegram-settings-copy.test.ts`:

```ts
// P1 settings UX copy: connected/disconnected states derived from DB status.

import { describe, expect, it } from "vitest";

import { telegramConnectionCopy } from "../../components/forms/telegram-settings";

describe("telegramConnectionCopy", () => {
  it("unknown status shows the loading state", () => {
    const copy = telegramConnectionCopy(null);
    expect(copy.connected).toBe(false);
    expect(copy.blurb).toContain("Loading");
  });

  it("disconnected state advertises risk and withdrawal alerts", () => {
    const copy = telegramConnectionCopy({
      connected: false,
      telegramUsername: null,
      chatMasked: null,
      riskAlertsEnabled: true,
      withdrawalAlertsEnabled: true,
      lastDelivery: null,
    });
    expect(copy.connected).toBe(false);
    expect(copy.blurb).toContain("risk");
    expect(copy.blurb).toContain("withdrawal");
  });

  it("connected state names the username", () => {
    const copy = telegramConnectionCopy({
      connected: true,
      telegramUsername: "vindex_user",
      chatMasked: null,
      riskAlertsEnabled: true,
      withdrawalAlertsEnabled: true,
      lastDelivery: null,
    });
    expect(copy.connected).toBe(true);
    expect(copy.blurb).toContain("@vindex_user");
  });

  it("connected state falls back to the masked chat id", () => {
    const copy = telegramConnectionCopy({
      connected: true,
      telegramUsername: null,
      chatMasked: "42…4242",
      riskAlertsEnabled: true,
      withdrawalAlertsEnabled: true,
      lastDelivery: null,
    });
    expect(copy.blurb).toContain("42…4242");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- --run tests/unit/telegram-settings-copy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `components/forms/telegram-settings.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";

type TelegramStatus = {
  connected: boolean;
  telegramUsername: string | null;
  chatMasked: string | null;
  riskAlertsEnabled: boolean;
  withdrawalAlertsEnabled: boolean;
  lastDelivery: { eventType: string; status: string; errorCode: string | null; attemptedAt: string } | null;
};

export const telegramConnectionCopy = (
  status: TelegramStatus | null,
): { heading: string; blurb: string; connected: boolean } => {
  if (status === null) {
    return { heading: "Telegram Alerts", blurb: "Loading connection status…", connected: false };
  }
  if (!status.connected) {
    return { heading: "Telegram Alerts", blurb: "Receive risk and verified-withdrawal alerts.", connected: false };
  }
  const who = status.telegramUsername !== null ? `@${status.telegramUsername}` : (status.chatMasked ?? "Telegram");
  return { heading: "Telegram Alerts", blurb: `Connected as ${who}.`, connected: true };
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; statusView: TelegramStatus | null }
  | { status: "error"; message: string };

const fetchStatus = async (): Promise<TelegramStatus | null> => {
  const response = await fetch("/api/vindex/telegram", { cache: "no-store" });
  if (!response.ok) return null;
  return (await response.json()) as TelegramStatus;
};

export function TelegramSettings() {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [connecting, setConnecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const statusView = await fetchStatus();
      setLoad({ status: "ready", statusView });
    } catch {
      setLoad({ status: "error", message: "Telegram connection status is unavailable." });
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const copy = telegramConnectionCopy(load.status === "ready" ? load.statusView : null);

  const connect = useCallback(async () => {
    setConnecting(true);
    setNotice(null);
    try {
      const response = await fetch("/api/vindex/telegram/connect", { method: "POST", cache: "no-store" });
      const body = (await response.json().catch(() => null)) as { connectUrl?: string; message?: string } | null;
      if (!response.ok || body?.connectUrl === undefined) {
        setNotice(body?.message ?? "Connection could not be started.");
        return;
      }
      window.open(body.connectUrl, "_blank", "noopener,noreferrer");
      setNotice("Open the opened Telegram chat and press Start. If it didn't open, press Start in your Vindex Alerts bot chat directly.");
      const startedAt = Date.now();
      const poll = setInterval(async () => {
        const statusView = await fetchStatus();
        if (statusView !== null && statusView.connected) {
          clearInterval(poll);
          setLoad({ status: "ready", statusView });
          setNotice("Connected.");
        } else if (Date.now() - startedAt > 90_000) {
          clearInterval(poll);
        }
      }, 3_000);
    } catch {
      setNotice("Connection could not be started.");
    } finally {
      setConnecting(false);
    }
  }, []);

  const setToggle = useCallback(async (key: "riskAlertsEnabled" | "withdrawalAlertsEnabled", value: boolean) => {
    setNotice(null);
    try {
      const response = await fetch("/api/vindex/telegram", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
        cache: "no-store",
      });
      const body = (await response.json().catch(() => null)) as TelegramStatus | null;
      if (response.ok && body !== null) {
        setLoad({ status: "ready", statusView: body });
      } else {
        setNotice("The alert preference could not be saved.");
      }
    } catch {
      setNotice("The alert preference could not be saved.");
    }
  }, []);

  const sendTest = useCallback(async () => {
    setTesting(true);
    setNotice(null);
    try {
      const response = await fetch("/api/vindex/telegram/test", { method: "POST", cache: "no-store" });
      const body = (await response.json().catch(() => null)) as { outcome?: { delivered?: boolean }; message?: string } | null;
      if (response.ok && body?.outcome?.delivered === true) {
        setNotice("Test alert sent.");
      } else {
        setNotice(body?.message ?? "The test alert could not be sent.");
      }
    } catch {
      setNotice("The test alert could not be sent.");
    } finally {
      setTesting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    setNotice(null);
    try {
      const response = await fetch("/api/vindex/telegram", { method: "DELETE", cache: "no-store" });
      if (response.ok) {
        setLoad({ status: "ready", statusView: { connected: false, telegramUsername: null, chatMasked: null, riskAlertsEnabled: true, withdrawalAlertsEnabled: true, lastDelivery: null } });
        setNotice("Telegram disconnected.");
      } else {
        setNotice("Disconnect failed.");
      }
    } catch {
      setNotice("Disconnect failed.");
    }
  }, []);

  const connected = load.status === "ready" && load.statusView !== null && load.statusView.connected;
  const statusView = load.status === "ready" ? load.statusView : null;

  return (
    <section className="telegram-settings" aria-labelledby="telegram-settings-heading">
      <p className="data-label" id="telegram-settings-heading">{copy.heading}</p>
      <h3>{copy.blurb}</h3>
      {load.status === "error" && <p className="form-error">{load.message}</p>}
      {load.status === "ready" && !connected && (
        <div className="diagnostic-actions">
          <button className="primary-cta" type="button" onClick={() => void connect()} disabled={connecting}>
            {connecting ? "Preparing connection…" : "Connect Telegram"}
          </button>
        </div>
      )}
      {load.status === "ready" && connected && (
        <>
          <div className="form-row">
            <span className="form-label">Risk alerts</span>
            <label className="toggle-label">
              <input
                type="checkbox"
                checked={statusView?.riskAlertsEnabled ?? true}
                onChange={(event) => void setToggle("riskAlertsEnabled", event.target.checked)}
              />
              <span className="toggle" aria-hidden="true" />
              {statusView?.riskAlertsEnabled ? "On" : "Off"}
            </label>
          </div>
          <div className="form-row">
            <span className="form-label">Withdrawal alerts</span>
            <label className="toggle-label">
              <input
                type="checkbox"
                checked={statusView?.withdrawalAlertsEnabled ?? true}
                onChange={(event) => void setToggle("withdrawalAlertsEnabled", event.target.checked)}
              />
              <span className="toggle" aria-hidden="true" />
              {statusView?.withdrawalAlertsEnabled ? "On" : "Off"}
            </label>
          </div>
          {statusView?.lastDelivery !== null && statusView?.lastDelivery !== undefined && (
            <p className="form-note">
              Last delivery: {statusView.lastDelivery.eventType} · {statusView.lastDelivery.status}
              {statusView.lastDelivery.errorCode !== null ? ` · ${statusView.lastDelivery.errorCode}` : ""}
            </p>
          )}
          <div className="diagnostic-actions">
            <button className="secondary-button" type="button" onClick={() => void sendTest()} disabled={testing}>
              {testing ? "Sending…" : "Send test alert"}
            </button>
            <button className="secondary-button" type="button" onClick={() => void disconnect()}>
              Disconnect
            </button>
          </div>
        </>
      )}
      {notice !== null && <p className="form-note">{notice}</p>}
    </section>
  );
}
```

- [ ] **Step 4: Add CSS to `app/globals.css`**

```css
.telegram-settings {
  margin-top: 24px;
  padding: 28px;
  border: 1px solid var(--ink);
  border-radius: var(--radius-control);
}

.telegram-settings h3 {
  margin-bottom: 14px;
}
```

- [ ] **Step 5: Add the section to the settings page**

Modify `app/(product)/settings/page.tsx`:

```tsx
import { SetupForm } from "@/components/forms/setup-form";
import { ConfigSummary } from "@/components/dashboard/config-summary";
import { TelegramSettings } from "@/components/forms/telegram-settings";

export default function SettingsPage() {
  return (
    <main id="main-content" className="route-page">
      <div className="content-wrap">
        <header className="route-page__heading"><h1>Route settings</h1><p>Review the supported position, safe wallet and policy before revalidation. Changing an armed route requires live checks again.</p></header>
        <div className="setup-layout">
          <SetupForm settings />
          <ConfigSummary />
        </div>
        <TelegramSettings />
      </div>
    </main>
  );
}
```

- [ ] **Step 6: Run tests**

Run: `npm run test:unit -- --run tests/unit/telegram-settings-copy.test.ts` — PASS.
Run: `npm run lint` and `npm run typecheck` — PASS.

- [ ] **Step 7: Commit**

```bash
git add components/forms/telegram-settings.tsx app/\(product\)/settings/page.tsx app/globals.css tests/unit/telegram-settings-copy.test.ts
git commit -m "feat: telegram alerts section in settings"
```

---

### Task 12: Webhook registration operator script + docs

**Files:**
- Create: `scripts/register-telegram-webhook.ts`, `docs/telegram-alerts.md`
- Modify: `package.json` (add `telegram:webhook` script)
- Test: `tests/unit/telegram-webhook-register.test.ts`

**Interfaces:**
- Produces: npm script `telegram:webhook` — `tsx scripts/register-telegram-webhook.ts`. Reads `APP_URL` from env or `--url` arg; requires `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET`; calls Bot API `setWebhook` with `url = <APP_URL>/api/integrations/telegram/webhook` and `secret_token`. Never prints the token or secret.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/telegram-webhook-register.test.ts`:

```ts
// P1 operator handoff: webhook registration is opt-in, HTTPS-only, and never
// exposes the bot token or webhook secret.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

describe("telegram webhook registration script", () => {
  it("is never invoked at startup or build time", async () => {
    const nextConfig = await readFile("next.config.ts", "utf8");
    const layout = await readFile("app/layout.tsx", "utf8");
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(nextConfig + layout).not.toMatch(/setWebhook|telegram:webhook/);
    expect(pkg.scripts["telegram:webhook"]).toBe("tsx scripts/register-telegram-webhook.ts");
    expect(Object.values(pkg.scripts).some((script) => script.includes("setWebhook"))).toBe(false);
  });

  it("registers the canonical webhook target and never prints secrets", async () => {
    const source = await readFile("scripts/register-telegram-webhook.ts", "utf8");
    expect(source).toContain("/api/integrations/telegram/webhook");
    expect(source).toContain("setWebhook");
    // The token and secret are used only inside the fetch body/URL.
    expect(source).not.toMatch(/console\.log\([^)]*token/i);
    expect(source).not.toMatch(/console\.log\([^)]*secret/i);
    expect(source).not.toMatch(/console\.(log|info)\(`[^`]*\$\{token\}[^`]*`/);
    expect(source).not.toMatch(/console\.(log|info)\(`[^`]*\$\{secret\}[^`]*`/);
  });

  it("documents the operator flow", async () => {
    const docs = await readFile("docs/telegram-alerts.md", "utf8");
    expect(docs).toContain("telegram:webhook");
    expect(docs).toContain("/api/integrations/telegram/webhook");
    expect(docs).toMatch(/APP_URL/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- --run tests/unit/telegram-webhook-register.test.ts`
Expected: FAIL — files missing.

- [ ] **Step 3: Implement the script**

Create `scripts/register-telegram-webhook.ts`:

```ts
// Registers the Telegram Bot API webhook for this deployment AFTER the app is
// reachable over HTTPS. Never runs at application startup or build time.
// Never prints the bot token or the webhook secret.
//
// Usage: npm run telegram:webhook -- --url https://your-app.example
//        (or set APP_URL in the environment)

import "dotenv/config";

const argUrl = process.argv.find((arg) => arg.startsWith("--url="))?.slice("--url=".length);
const appUrl = (argUrl ?? process.env.APP_URL)?.trim();
const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

if (!appUrl) {
  console.error("APP_URL is required. Pass --url https://your-app.example or set APP_URL.");
  process.exit(1);
}
if (!botToken || !webhookSecret) {
  console.error("TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET must be set in .env.");
  process.exit(1);
}
if (!appUrl.startsWith("https://")) {
  console.error("Telegram requires an HTTPS webhook URL.");
  process.exit(1);
}

const url = `${appUrl.replace(/\/+$/, "")}/api/integrations/telegram/webhook`;
const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url, secret_token: webhookSecret }),
});
const body = (await response.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
if (!response.ok || body?.ok !== true) {
  console.error(`setWebhook failed: ${body?.description ?? String(response.status)}`);
  process.exit(1);
}
console.log(`Telegram webhook registered for ${url}.`);
console.log("The bot token and webhook secret were not printed.");
console.log("Users can now connect via Settings -> Telegram Alerts -> Connect Telegram.");
```

- [ ] **Step 4: Add the npm script**

Modify `package.json` scripts:

```json
"telegram:webhook": "tsx scripts/register-telegram-webhook.ts"
```

- [ ] **Step 5: Write `docs/telegram-alerts.md`**

```markdown
# Telegram alerts

Vindex sends best-effort Telegram alerts (risk, verified-withdrawal, test) for
the protected position. Telegram is observability only — it can never approve
a withdrawal, change a safe wallet, arm a policy, or trigger execution.

## 1. Configure environment

Copy `.env.example` and set:

- `TELEGRAM_BOT_TOKEN` — token from @BotFather
- `TELEGRAM_BOT_USERNAME` — the bot username (e.g. `VindexAlertsBot`)
- `TELEGRAM_WEBHOOK_SECRET` — a long random string you choose (validated on every webhook request)

## 2. Deploy first

The webhook URL must be HTTPS. Deploy the app, then register the webhook with
the operator script (it never runs at startup or build):

```bash
npm run telegram:webhook -- --url https://your-app.example
```

Target: `https://your-app.example/api/integrations/telegram/webhook`

## 3. Connect in the product

Open Settings -> Telegram Alerts -> Connect Telegram, press Start in the bot
chat. Connection is bound to the protected position.

## 4. Alerts

- Risk alert: after a fresh confirmation re-read passes (CONFIRMING), before any execution — once per decision.
- Protected alert: only after destination verification passes and the position is PROTECTED — once per receipt.
- Test alert: fixed message, no fake incident.

Delivery failures never block or alter protection. Each attempt is recorded in
`notification_deliveries`; failures emit a `TELEGRAM_ALERT_FAILED` audit event.
```

- [ ] **Step 6: Run the tests**

Run: `npm run test:unit -- --run tests/unit/telegram-webhook-register.test.ts` — PASS.
Run: `npm run lint` — PASS (script top-level await is fine for tsx; if ESLint complains about top-level await, wrap in a `main()`).

- [ ] **Step 7: Commit**

```bash
git add scripts/register-telegram-webhook.ts docs/telegram-alerts.md package.json tests/unit/telegram-webhook-register.test.ts
git commit -m "feat: opt-in telegram webhook registration script and docs"
```

---

### Task 13: E2E updates + full quality gates + M10/zero-chain-write proofs

**Files:**
- Modify: `tests/e2e/vindex.spec.ts` (only if the settings smoke needs an assertion; verify the existing `/settings` route smoke and the `sepolia.basescan.org` assertion still pass first)
- No production code changes in this task.

- [ ] **Step 1: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS. Confirm new files: `telegram-schema`, `basescan`, `signal-family-labels`, `telegram-client`, `notification-service`, `telegram-webhook`, `telegram-routes`, `telegram-settings-copy`, `telegram-webhook-register`, plus updated `env`, `policy-service`, `verification-service`.

- [ ] **Step 2: Run lint + typecheck + build**

Run: `npm run lint` — PASS.
Run: `npm run typecheck` — PASS.
Run: `npm run build` — PASS (watch for client-bundle issues from `basescan.ts` importing `chain.ts` — if the build reports viem/client bundling problems, inline the canonical base URL constant in `basescan.ts` instead and keep a source-level assertion tying it to `sepolia.basescan.org`).

- [ ] **Step 3: Run e2e**

Run: `npm run test:e2e`
Expected: PASS. The e2e suite aborts `/api/**` in `beforeEach`, so `TelegramSettings` renders its neutral "loading" state and the settings smoke stays green. Monitor assertions (`sepolia.basescan.org`) still pass because the anchor href contains the string. If any assertion regresses, update ONLY the test mock/assertion (never product behavior) and re-run.

- [ ] **Step 4: Verify migration hygiene**

Run: `npm run db:generate` — expected: no new migration (idempotent) OR a no-op diff; if drizzle emits a new migration, inspect `git diff drizzle/` and commit it.
Run: `npm run db:migrate` — applies cleanly (already applied locally; idempotent).

- [ ] **Step 5: M10 historical-proof + zero-chain-write proof**

Run:
```bash
git status --short
git diff --stat HEAD -- artifacts/
git diff HEAD -- lib/vindex/demo-run.ts scripts/demo-m10-e2e.ts lib/vindex/execution-service.ts lib/vindex/m1-execution.ts lib/vindex/m2-execution.ts scripts/execute-m7-evacuation.ts
```
Expected:
- `artifacts/` and all M0–M10 scripts untouched (empty diff).
- Only new/modified files are the P1 set.
- No `demo_runs` row touched: no demo script was executed; the only DB writes made were the additive migration + test database usage.
- Evidence: `git log --oneline -10` shows only the P1 commit chain on top of `faa0fdb`.

Record the exact `git diff --stat` output and the M10 artifact hashes (e.g. `git rev-parse HEAD:artifacts/m10-e2e-proof.json`) into the completion report as the historical-proof section.

- [ ] **Step 6: Final regression sweep**

Run once more: `npm run test:unit && npm run lint && npm run typecheck && npm run build`
Expected: all PASS.

- [ ] **Step 7: Commit (final)**

```bash
git add tests/e2e/vindex.spec.ts
git commit -m "test: e2e coverage for P1 settings and transaction links"
```

---

## Self-Review Notes

- Spec §A (readability) → Task 5. §B (tx links) → Tasks 3–4. §C (schema) → Task 1. §D (connection flow) → Tasks 9–10. §E (delivery service) → Tasks 2, 6, 7. §F (risk alert) → Tasks 7–8. §G (withdrawal alert) → Tasks 7–8. §H (delivery safety) → Task 7 (`deliverTelegramAlert` never throws; failures record FAILED + `TELEGRAM_ALERT_FAILED` audit; no state-machine interaction). §I (settings UX) → Task 11. §J (tests) → covered per task; UI connected/disconnected states covered by service-level status tests + `telegramConnectionCopy` unit tests. §K (handoff) → Task 12. §L (quality) → Task 13.
- Type consistency: `WithdrawalReceiptFacts` is the single structural type for withdrawal alerts (satisfied by `RescueReceiptRow` and `RescueReceiptView`); `TelegramStatusView` is the single shape returned by the service and the routes and consumed by the component. `NotificationOutcome` is the single result type used by routes and services.
- The risk-alert hook lives ONLY in `transitionToConfirming` (policy-service) — the idempotent already-CONFIRMING early return and re-evaluation paths never re-alert, and the `(subscriptionId, eventType, eventKey)` unique index is the final backstop.
- The withdrawal-alert hook lives ONLY after the PROTECTED transaction + audits in `verifyEvacuationDestination`; the idempotent early-return path never reaches it; `receipt.status !== "PROTECTED"` is an additional guard inside `notifyWithdrawalComplete`.
- No real Telegram API calls in tests: `lib/telegram/client` is always `vi.mock`ed; the operator script is never executed by tests.
