// P1 schema: subscription, connect-token (hash only) and delivery dedup
// constraints. The bot token itself must never appear in the schema.

import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";

import {
  notificationDeliveries,
  telegramConnectTokens,
  telegramSubscriptions,
} from "../../db/schema";
import { closeTestDb, getTestDb } from "./helpers/test-db";

const dbAvailable = Boolean(process.env.DATABASE_URL?.trim());
let db: Awaited<ReturnType<typeof getTestDb>>;

const POSITION_ID = "base-sepolia:aave-v3:usdc:0x675638ddbbf8b70b906d68e3485da72c6c63d130";

// The active-uniq partial index allows exactly ONE active subscription per
// position, so fixtures that need their own active row use a distinct position.
const positionId = (suffix: string) => `${POSITION_ID}:${suffix}`;

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
      positionId: positionId("big-chat"),
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
        positionId: positionId("deliveries"),
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
