// P1 Telegram delivery: content from REAL records, exactly-once dedup per
// event key, toggle gating, PROTECTED-only withdrawal alerts, and failures
// that never throw and never touch the protection state machine. The Telegram
// transport is mocked — zero real network, zero blockchain writes.

import { describe, expect, it, vi, afterAll, beforeAll, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";

import { eq } from "drizzle-orm";

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
// Real M10 evacuation tx (artifacts/m10-e2e-proof.json), 64 hex chars.
const TX_HASH = "0x22670c665c86ad8d782fa1ff954ff4b6bf20a29d66a715378ed9d90efdff0806";

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
  if (dbAvailable) await closeTestDb();
});

// Delivery tests seed the same (position, chat) subscription; the schema
// allows exactly one active subscription per position, so each test starts
// from a clean subscription/delivery state. Telegram-failure audits are also
// cleared so audit-count assertions stay precise.
beforeEach(async () => {
  mockSend.mockClear();
  if (!dbAvailable) return;
  await db.delete(notificationDeliveries);
  await db.delete(telegramSubscriptions);
  await db.delete(auditEvents).where(eq(auditEvents.positionId, POSITION_ID));
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
    expect(audits).toHaveLength(1);
  });

  it.skipIf(!dbAvailable)("a throwing transport never propagates and records a FAILED delivery + audit", async () => {
    mockSend.mockRejectedValueOnce(new Error("boom"));
    await seedSubscription();
    const outcome = await notifyRiskAlert({ db, positionId: POSITION_ID, decision: decisionRow as never, policy, matchedFamilies });
    expect(outcome.failed).toBe(true);
    expect(outcome.errorCode).toBe("TELEGRAM_ALERT_FAILED");
    const rows = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.eventKey, `decision:${DECISION_ID}`));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("FAILED");
    expect(rows[0].errorCode).toBe("TELEGRAM_ALERT_FAILED");
    const audits = await db.select().from(auditEvents).where(eq(auditEvents.eventType, "TELEGRAM_ALERT_FAILED"));
    expect(audits).toHaveLength(1);
  });

  it("a failing position lookup yields a failed outcome and never throws", async () => {
    // Pre-flight lookups run outside deliverTelegramAlert's try, so they are
    // wrapped individually; a stubbed db whose select throws proves the
    // never-throw contract without touching the real database.
    const brokenDb = { select: () => { throw new Error("db down"); } } as never;
    const risk = await notifyRiskAlert({
      db: brokenDb,
      positionId: POSITION_ID,
      decision: decisionRow as never,
      policy,
      matchedFamilies,
    });
    expect(risk.failed).toBe(true);
    expect(risk.errorCode).toBe("TELEGRAM_ALERT_FAILED");
    const withdrawal = await notifyWithdrawalComplete({
      db: brokenDb,
      positionId: POSITION_ID,
      receipt: receiptFacts as never,
      execution: executionRow as never,
      policyMode: "DRILL_HIGH_SENSITIVITY",
      policyLabel: "Protection Drill / High Sensitivity",
    });
    expect(withdrawal.failed).toBe(true);
    expect(withdrawal.errorCode).toBe("TELEGRAM_ALERT_FAILED");
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
