// M3 durable schema. Amounts are stored as decimal strings (text) so uint256
// values survive losslessly — never JS floating point.
import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const CONFIG_SINGLETON_ID = "singleton";

export const vindexConfig = pgTable("vindex_config", {
  id: varchar("id", { length: 64 }).primaryKey(),
  safeWallet: varchar("safe_wallet", { length: 42 }),
  configuredAt: timestamp("configured_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const protectedPositions = pgTable("protected_positions", {
  // Stable canonical position id, e.g. "base-sepolia:aave-v3:usdc:<wallet>".
  id: varchar("id", { length: 128 }).primaryKey(),
  chainId: integer("chain_id").notNull(),
  protocol: varchar("protocol", { length: 32 }).notNull(),
  poolAddress: varchar("pool_address", { length: 42 }).notNull(),
  assetAddress: varchar("asset_address", { length: 42 }).notNull(),
  assetSymbol: varchar("asset_symbol", { length: 16 }).notNull(),
  assetDecimals: integer("asset_decimals").notNull(),
  positionTokenAddress: varchar("position_token_address", { length: 42 }).notNull(),
  executionWallet: varchar("execution_wallet", { length: 42 }).notNull(),
  safeWallet: varchar("safe_wallet", { length: 42 }),
  latestPositionAmount: text("latest_position_amount").notNull(),
  latestUnderlyingWalletBalance: text("latest_underlying_wallet_balance").notNull(),
  latestNativeBalanceWei: text("latest_native_balance_wei").notNull(),
  latestAllowance: text("latest_allowance").notNull(),
  latestBlockNumber: text("latest_block_number").notNull(),
  latestBlockTimestamp: timestamp("latest_block_timestamp", { withTimezone: true }),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type VindexConfigRow = typeof vindexConfig.$inferSelect;
export type ProtectedPositionRow = typeof protectedPositions.$inferSelect;

// M4: live signal observations. uint256/block values are stored as lossless
// decimal strings. Dedup uniqueness: (positionId, sourceFamily, metric,
// contractAddress, blockNumber) — same metric+block never duplicates.
export const signalObservations = pgTable(
  "signal_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    positionId: varchar("position_id", { length: 128 }).notNull(),
    chainId: integer("chain_id").notNull(),
    protocol: varchar("protocol", { length: 32 }).notNull(),
    sourceFamily: varchar("source_family", { length: 32 }).notNull(),
    metric: varchar("metric", { length: 64 }).notNull(),
    rawValue: text("raw_value").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    severity: varchar("severity", { length: 16 }),
    contractAddress: varchar("contract_address", { length: 42 }).notNull(),
    blockNumber: text("block_number").notNull(),
    blockTimestamp: timestamp("block_timestamp", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    rpcSource: varchar("rpc_source", { length: 256 }).notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("signal_observations_dedup_idx").on(
      table.positionId,
      table.sourceFamily,
      table.metric,
      table.contractAddress,
      table.blockNumber,
    ),
  ],
);

export type SignalObservationRow = typeof signalObservations.$inferSelect;

// M5: versioned protection policies, consensus decisions, and the append-only
// audit trail. One armed policy per position; one active decision per policy.
export const protectionPolicies = pgTable(
  "protection_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    positionId: varchar("position_id", { length: 128 }).notNull(),
    mode: varchar("mode", { length: 32 }).notNull(),
    requiredSignals: integer("required_signals").notNull(),
    correlationWindowSec: integer("correlation_window_sec").notNull(),
    thresholdsJson: text("thresholds_json").notNull(),
    safeWalletSnapshot: varchar("safe_wallet_snapshot", { length: 42 }).notNull(),
    isArmed: boolean("is_armed").notNull().default(false),
    armedAt: timestamp("armed_at", { withTimezone: true }),
    disarmedAt: timestamp("disarmed_at", { withTimezone: true }),
    version: integer("version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Enforce one armed policy per position at the database level.
    uniqueIndex("protection_policies_armed_uniq")
      .on(table.positionId)
      .where(sql`${table.isArmed} = true`),
  ],
);

export const threatDecisions = pgTable(
  "threat_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    positionId: varchar("position_id", { length: 128 }).notNull(),
    policyId: uuid("policy_id").notNull(),
    policyVersion: integer("policy_version").notNull(),
    state: varchar("state", { length: 32 }).notNull(),
    matchedCount: integer("matched_count").notNull().default(0),
    contributingSignalIds: text("contributing_signal_ids").notNull().default("[]"),
    matchedFamiliesJson: text("matched_families_json").notNull().default("[]"),
    reasonJson: text("reason_json").notNull().default("{}"),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One active (ELEVATED/CONFIRMING) decision per policy/window.
    uniqueIndex("threat_decisions_active_uniq")
      .on(table.policyId)
      .where(sql`${table.state} in ('ELEVATED', 'CONFIRMING')`),
  ],
);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  positionId: varchar("position_id", { length: 128 }).notNull(),
  decisionId: uuid("decision_id"),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  detailsJson: text("details_json").notNull().default("{}"),
  blockNumber: text("block_number"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProtectionPolicyRow = typeof protectionPolicies.$inferSelect;
export type ThreatDecisionRow = typeof threatDecisions.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;

// M6: withdrawal simulations and prepared evacuation executions. executions
// holds one row per decision (decisionId UNIQUE) so a decision cannot prepare
// competing evacuations. M6 rows carry no keeperhubExecutionId/txHash.
export const simulations = pgTable("simulations", {
  id: uuid("id").primaryKey().defaultRandom(),
  decisionId: uuid("decision_id").notNull(),
  chainId: integer("chain_id").notNull(),
  target: varchar("target", { length: 42 }).notNull(),
  function: varchar("function", { length: 64 }).notNull(),
  parametersJson: text("parameters_json").notNull(),
  parametersHash: varchar("parameters_hash", { length: 64 }).notNull(),
  blockNumber: text("block_number"),
  blockTimestamp: timestamp("block_timestamp", { withTimezone: true }),
  success: boolean("success").notNull(),
  wouldRevert: boolean("would_revert").notNull().default(false),
  gasEstimate: text("gas_estimate"),
  simulatedReturnValue: text("simulated_return_value"),
  revertReason: text("revert_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const executions = pgTable(
  "executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    decisionId: uuid("decision_id").notNull(),
    simulationId: uuid("simulation_id"),
    status: varchar("status", { length: 32 }).notNull(),
    chainId: integer("chain_id").notNull(),
    target: varchar("target", { length: 42 }).notNull(),
    function: varchar("function", { length: 64 }).notNull(),
    parametersHash: varchar("parameters_hash", { length: 64 }).notNull(),
    requestedAmount: text("requested_amount").notNull(),
    safeWallet: varchar("safe_wallet", { length: 42 }).notNull(),
    keeperhubExecutionId: varchar("keeperhub_execution_id", { length: 128 }),
    txHash: varchar("tx_hash", { length: 66 }),
    blockNumber: text("block_number"),
    blockTimestamp: timestamp("block_timestamp", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    errorCode: varchar("error_code", { length: 64 }),
    errorDetailsJson: text("error_details_json"),
    idempotencyKey: varchar("idempotency_key", { length: 160 }),
    broadcastRequestHash: varchar("broadcast_request_hash", { length: 64 }),
    lastKeeperHubStatus: varchar("last_keeperhub_status", { length: 32 }),
    transactionLink: varchar("transaction_link", { length: 256 }),
    sponsored: boolean("sponsored"),
    submissionError: varchar("submission_error", { length: 512 }),
    prePositionAmount: text("pre_position_amount"),
    preSafeWalletBalance: text("pre_safe_wallet_balance"),
    preBlockNumber: text("pre_block_number"),
    preBlockTimestamp: timestamp("pre_block_timestamp", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One prepared execution per decision — no competing evacuations.
    uniqueIndex("executions_decision_uniq").on(table.decisionId),
  ],
);

export type SimulationRow = typeof simulations.$inferSelect;
export type ExecutionRow = typeof executions.$inferSelect;

// M8: destination verification checks and the final Rescue Receipt. One
// execution can produce only one final receipt (executionId UNIQUE). Amounts
// are lossless decimal strings.
export const verificationChecks = pgTable("verification_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  executionId: uuid("execution_id").notNull(),
  assetAddress: varchar("asset_address", { length: 42 }).notNull(),
  destination: varchar("destination", { length: 42 }).notNull(),
  preBalance: text("pre_balance").notNull(),
  postBalance: text("post_balance").notNull(),
  delta: text("delta").notNull(),
  expectedAmount: text("expected_amount").notNull(),
  verified: boolean("verified").notNull().default(false),
  blockNumber: text("block_number").notNull(),
  blockTimestamp: timestamp("block_timestamp", { withTimezone: true }).notNull(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  failureReason: text("failure_reason"),
});

export const rescueReceipts = pgTable(
  "rescue_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    executionId: uuid("execution_id").notNull(),
    positionId: varchar("position_id", { length: 128 }).notNull(),
    policyMode: varchar("policy_mode", { length: 32 }).notNull(),
    verifiedAmount: text("verified_amount").notNull(),
    destination: varchar("destination", { length: 42 }).notNull(),
    txHash: varchar("tx_hash", { length: 66 }).notNull(),
    keeperhubExecutionId: varchar("keeperhub_execution_id", { length: 128 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("PROTECTED"),
    receiptJson: text("receipt_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("rescue_receipts_execution_uniq").on(table.executionId),
  ],
);

export type VerificationCheckRow = typeof verificationChecks.$inferSelect;
export type RescueReceiptRow = typeof rescueReceipts.$inferSelect;

// M10: durable orchestration record for the end-to-end demo run. One active
// run at a time (partial unique index over non-terminal statuses). Every
// external write is recoverable from this row via its persisted execution ids.
export const demoRuns = pgTable(
  "demo_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    status: varchar("status", { length: 32 }).notNull().default("CREATED"),
    positionId: varchar("position_id", { length: 128 }).notNull(),
    fundingExecutionId: varchar("funding_execution_id", { length: 128 }),
    approvalExecutionId: varchar("approval_execution_id", { length: 128 }),
    supplyExecutionId: varchar("supply_execution_id", { length: 128 }),
    policyId: uuid("policy_id"),
    decisionId: uuid("decision_id"),
    evacuationExecutionId: uuid("evacuation_execution_id"),
    rescueReceiptId: uuid("rescue_receipt_id"),
    startingBlockNumber: text("starting_block_number"),
    startingBlockTimestamp: timestamp("starting_block_timestamp", { withTimezone: true }),
    preDemoSafeWalletBalance: text("pre_demo_safe_wallet_balance"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorCode: varchar("error_code", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("demo_runs_active_uniq")
      .on(table.positionId)
      .where(sql`${table.status} not in ('PROTECTED', 'FAILED')`),
  ],
);

export type DemoRunRow = typeof demoRuns.$inferSelect;

// P1: Telegram alerting. Subscriptions bind to the protected position
// (positionId) — Vindex has no user/auth model. Only token hashes are stored;
// the bot secret itself never touches the database.
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
