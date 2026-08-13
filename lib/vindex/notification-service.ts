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
  ThreatDecisionRow,
} from "../../db/schema";
import { sendTelegramMessage } from "../telegram/client";
import { formatFamilyLabel } from "../signal-family-labels";
import { buildBaseScanTxUrl } from "./basescan";
import { getTelegramEnv } from "./env";
import type { MatchedFamilyView, PolicyView } from "./policy-service";
import { DRILL_LABEL } from "./policy-templates";

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
  } catch {
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

// Test alerts take the same params-object shape as notifyRiskAlert and
// notifyWithdrawalComplete; every alert keyed `test:<uuid>` is a fresh event,
// so repeated tests always deliver.
export const sendTestAlert = async (params: {
  db: VindexDb;
  positionId: string;
  now?: () => Date;
}): Promise<NotificationOutcome> =>
  deliverTelegramAlert(
    params.db,
    params.positionId,
    "TEST",
    `test:${randomUUID()}`,
    () => "Vindex Telegram alerts are connected successfully.",
    { now: params.now },
  );
