// P1 Telegram settings API: status from the DB, toggles, disconnect, connect
// token issuance (hash-only storage) and the test alert.

import { describe, expect, it, vi, afterAll, beforeAll } from "vitest";

import { eq } from "drizzle-orm";

import {
  notificationDeliveries,
  telegramConnectTokens,
  telegramSubscriptions,
} from "../../db/schema";
import {
  disconnectTelegram,
  getTelegramStatus,
  updateTelegramToggles,
} from "../../lib/vindex/telegram-service";
import { hashConnectToken } from "../../lib/vindex/telegram-connect";
import { closeTestDb, getTestDb } from "./helpers/test-db";

const { WALLET } = vi.hoisted(() => ({
  WALLET: "0x675638ddbbf8b70b906d68e3485da72c6c63d130",
}));

vi.mock("../../lib/telegram/client", () => ({
  sendTelegramMessage: vi.fn(async () => ({ ok: true, messageId: "7", errorCode: null })),
}));

// The connect/test routes resolve the position via
// createKeeperHubClient().getOrganizationWallet(); stub the client so route
// tests never hit the KeeperHub network.
vi.mock("@/lib/vindex/keeperhub", () => ({
  createKeeperHubClient: () => ({
    getOrganizationWallet: async () => ({
      hasWallet: true,
      walletAddress: WALLET,
      walletId: "wal_test",
      isActive: true,
      invalidAddress: false,
      error: null,
    }),
  }),
}));

import { PATCH } from "../../app/api/vindex/telegram/route";
import { POST as connectPOST } from "../../app/api/vindex/telegram/connect/route";
import { POST as testPOST } from "../../app/api/vindex/telegram/test/route";

const dbAvailable = Boolean(process.env.DATABASE_URL?.trim());
let db: Awaited<ReturnType<typeof getTestDb>>;

const POSITION_ID = `base-sepolia:aave-v3:usdc:${WALLET}`;

// The routes read DATABASE_URL at request time (getDb), so the route tests
// point it at the same test database the fixture helpers use (vindex_test on
// the local docker Postgres) — never at the production DATABASE_URL.
const testBaseUrl = process.env.TEST_DATABASE_URL?.trim() ?? process.env.DATABASE_URL?.trim();
const routeDatabaseUrl = (() => {
  if (!testBaseUrl) return null;
  const url = new URL(testBaseUrl);
  const databaseName = url.pathname.slice(1) || "vindex";
  url.pathname = `/${databaseName === "vindex" ? "vindex_test" : `${databaseName}_test`}`;
  return url.toString();
})();

const stubRouteEnv = () => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:abc");
  vi.stubEnv("TELEGRAM_BOT_USERNAME", "VindexAlertsBot");
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "secret");
  if (routeDatabaseUrl !== null) vi.stubEnv("DATABASE_URL", routeDatabaseUrl);
};

beforeAll(async () => {
  if (!dbAvailable) return;
  db = await getTestDb();
  await db.delete(notificationDeliveries);
  await db.delete(telegramSubscriptions);
  await db.delete(telegramConnectTokens);
});

afterAll(async () => {
  if (dbAvailable) {
    // The routes create their own getDb() postgres pool (global cache); close
    // it so the worker does not hang on the open socket.
    const routeSql = (globalThis as { vindexPostgres?: { end(): Promise<unknown> } })
      .vindexPostgres;
    if (routeSql !== undefined) await routeSql.end();
  }
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
    // A username is the display identity, so the chat id stays masked/unused.
    expect(status.chatMasked).toBeNull();
  });

  it.skipIf(!dbAvailable)("masks the chat id when no username is set", async () => {
    await db.insert(telegramSubscriptions).values({
      positionId: `${POSITION_ID}:masked`,
      chatId: "42424242",
      riskAlertsEnabled: true,
      withdrawalAlertsEnabled: true,
    });
    const status = await getTelegramStatus(db, `${POSITION_ID}:masked`);
    expect(status.connected).toBe(true);
    expect(status.telegramUsername).toBeNull();
    expect(status.chatMasked).toBe("42…4242");
  });

  it.skipIf(!dbAvailable)("toggles persist to the subscription row", async () => {
    const updated = await updateTelegramToggles(db, POSITION_ID, { riskAlertsEnabled: false });
    expect(updated.riskAlertsEnabled).toBe(false);
    const rows = await db.select().from(telegramSubscriptions).where(eq(telegramSubscriptions.positionId, POSITION_ID));
    expect(rows[0].riskAlertsEnabled).toBe(false);
  });

  it.skipIf(!dbAvailable)("reports the latest delivery attempt", async () => {
    const positionId = `${POSITION_ID}:delivery`;
    const inserted = await db
      .insert(telegramSubscriptions)
      .values({
        positionId,
        chatId: "42424242",
        telegramUsername: "vindex_user",
        riskAlertsEnabled: true,
        withdrawalAlertsEnabled: true,
      })
      .returning();
    const attemptedAt = new Date("2026-08-13T12:00:00.000Z");
    await db.insert(notificationDeliveries).values({
      subscriptionId: inserted[0].id,
      eventType: "TEST",
      eventKey: "test:delivery-view",
      status: "SENT",
      telegramMessageId: "9",
      errorCode: null,
      attemptedAt,
    });
    const status = await getTelegramStatus(db, positionId);
    expect(status.lastDelivery).toEqual({
      eventType: "TEST",
      status: "SENT",
      errorCode: null,
      attemptedAt: attemptedAt.toISOString(),
    });
  });

  it.skipIf(!dbAvailable)("disconnect soft-removes the subscription", async () => {
    await disconnectTelegram(db, POSITION_ID);
    const status = await getTelegramStatus(db, POSITION_ID);
    expect(status.connected).toBe(false);
  });
});

describe("telegram routes", () => {
  it.skipIf(!dbAvailable)("connect issues a token and returns the deep link", async () => {
    stubRouteEnv();
    try {
      const response = await connectPOST();
      expect(response.status).toBe(200);
      const body = (await response.json()) as { token: string; botUsername: string; connectUrl: string; expiresAt: string };
      expect(body.botUsername).toBe("VindexAlertsBot");
      expect(body.connectUrl).toBe(`https://t.me/VindexAlertsBot?start=${body.token}`);
      expect(body.token).toBeTruthy();
      expect(body.expiresAt).toBeTruthy();
      const rows = await db.select().from(telegramConnectTokens);
      expect(rows[0].tokenHash).toBe(hashConnectToken(body.token));
      // Hash-only storage: the raw token must never reach the database.
      expect(JSON.stringify(rows)).not.toContain(body.token);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("connect returns 503 SERVER_NOT_CONFIGURED without Telegram env", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    vi.stubEnv("TELEGRAM_BOT_USERNAME", "");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "");
    try {
      const response = await connectPOST();
      expect(response.status).toBe(503);
      expect((await response.json()).error).toBe("SERVER_NOT_CONFIGURED");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("test returns 503 SERVER_NOT_CONFIGURED without required env", async () => {
    vi.stubEnv("BASE_SEPOLIA_RPC_URL", "");
    vi.stubEnv("KEEPERHUB_API_KEY", "");
    try {
      const response = await testPOST();
      expect(response.status).toBe(503);
      expect((await response.json()).error).toBe("SERVER_NOT_CONFIGURED");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("PATCH rejects unknown fields", async () => {
    const response = await PATCH(
      new Request("https://vindex.local/api/vindex/telegram", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ riskAlertsEnabled: true, foo: 1 }),
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("UNKNOWN_FIELD");
  });

  it("PATCH rejects non-boolean toggle values", async () => {
    const response = await PATCH(
      new Request("https://vindex.local/api/vindex/telegram", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ riskAlertsEnabled: "yes" }),
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("BAD_REQUEST");
  });

  it("PATCH rejects a non-object body", async () => {
    const response = await PATCH(
      new Request("https://vindex.local/api/vindex/telegram", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "null",
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("BAD_REQUEST");
  });

  it("PATCH rejects malformed JSON", async () => {
    const response = await PATCH(
      new Request("https://vindex.local/api/vindex/telegram", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "{not-json",
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("BAD_REQUEST");
  });
});
