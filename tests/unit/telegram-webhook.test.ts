// P1 Telegram connection: one-time short-lived tokens (hash-only storage),
// webhook secret enforcement, and /start binding the correct subscription.

import { describe, expect, it, vi, afterAll, beforeAll, beforeEach } from "vitest";

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

import { sendTelegramMessage } from "../../lib/telegram/client";
import { POST } from "../../app/api/integrations/telegram/webhook/route";

const dbAvailable = Boolean(process.env.DATABASE_URL?.trim());
let db: Awaited<ReturnType<typeof getTestDb>>;

const WALLET = "0x675638ddbbf8b70b906d68e3485da72c6c63d130";
const POSITION_ID = `base-sepolia:aave-v3:usdc:${WALLET}`;
const CHAT_ID = "42424242";
const SECRET = "super-secret-webhook-secret";

// The route reads DATABASE_URL at request time (getDb), so the route tests
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

// Mirrors the brief's per-test env stubbing; additionally routes getDb to the
// test database so /start binding runs against the local Postgres, not prod.
const stubRouteEnv = () => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:abc");
  vi.stubEnv("TELEGRAM_BOT_USERNAME", "VindexAlertsBot");
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
  if (routeDatabaseUrl !== null) vi.stubEnv("DATABASE_URL", routeDatabaseUrl);
};

beforeAll(async () => {
  if (!dbAvailable) return;
  db = await getTestDb();
  await db.delete(telegramSubscriptions);
  await db.delete(telegramConnectTokens);
});

// Brief tests assert TOTAL row counts (e.g. subs length 1), so every test
// starts from an empty telegram state. Same endorsed pattern as task 7.
beforeEach(async () => {
  if (!dbAvailable) return;
  await db.delete(telegramSubscriptions);
  await db.delete(telegramConnectTokens);
});

afterAll(async () => {
  if (dbAvailable) {
    // The route creates its own getDb() postgres pool (global cache); close it
    // so the worker does not hang on the open socket.
    const routeSql = (globalThis as { vindexPostgres?: { end(): Promise<unknown> } })
      .vindexPostgres;
    if (routeSql !== undefined) await routeSql.end();
  }
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

  it.skipIf(!dbAvailable)("a second active subscription for the same position is rejected by the index", async () => {
    // Closes the T1 deferred minor: the telegram-subscriptions partial unique
    // index (positionId WHERE disconnectedAt IS NULL) rejects a second active row.
    const position = `${POSITION_ID}:active-uniq`;
    await db.insert(telegramSubscriptions).values({
      positionId: position,
      chatId: "111",
      riskAlertsEnabled: true,
      withdrawalAlertsEnabled: true,
    });
    await expect(
      db.insert(telegramSubscriptions).values({
        positionId: position,
        chatId: "222",
        riskAlertsEnabled: true,
        withdrawalAlertsEnabled: true,
      }),
    ).rejects.toThrow();
    const active = await db
      .select()
      .from(telegramSubscriptions)
      .where(eq(telegramSubscriptions.positionId, position));
    expect(active.filter((s) => s.disconnectedAt === null)).toHaveLength(1);
  });
});

describe("webhook route", () => {
  it("returns 503 when Telegram is not configured", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    vi.stubEnv("TELEGRAM_BOT_USERNAME", "");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "");
    try {
      const response = await POST(webhookRequest({ message: { chat: { id: CHAT_ID }, text: "/start x" } }));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "SERVER_NOT_CONFIGURED" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("requires the webhook secret header", async () => {
    stubRouteEnv();
    try {
      const missing = await POST(webhookRequest({}, null));
      expect(missing.status).toBe(403);
      const wrong = await POST(webhookRequest({}, "wrong-secret"));
      expect(wrong.status).toBe(403);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returns 400 for invalid JSON", async () => {
    stubRouteEnv();
    try {
      const response = await POST(
        new Request("https://vindex.local/api/integrations/telegram/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Telegram-Bot-Api-Secret-Token": SECRET,
          },
          body: "{not-json",
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "BAD_REQUEST" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("responds NO_CHAT when the update has no chat", async () => {
    stubRouteEnv();
    try {
      const response = await POST(webhookRequest({ message: { text: "/start abc" } }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: false, reason: "NO_CHAT" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("ignores non-/start messages", async () => {
    stubRouteEnv();
    try {
      const response = await POST(webhookRequest({ message: { chat: { id: CHAT_ID }, text: "hello bot" } }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, reason: "IGNORED" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("responds NO_TOKEN for a bare /start", async () => {
    stubRouteEnv();
    try {
      const response = await POST(webhookRequest({ message: { chat: { id: CHAT_ID }, text: "/start" } }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: false, reason: "NO_TOKEN" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.skipIf(!dbAvailable)("returns INVALID_TOKEN for an unknown token", async () => {
    stubRouteEnv();
    try {
      const response = await POST(
        webhookRequest({ message: { chat: { id: CHAT_ID }, text: "/start not-a-real-token" } }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: false, reason: "INVALID_TOKEN" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.skipIf(!dbAvailable)("returns EXPIRED for an expired token", async () => {
    const { token } = await createConnectToken(
      db,
      POSITION_ID,
      () => new Date(Date.now() - 30 * 60 * 1000),
    );
    stubRouteEnv();
    try {
      const response = await POST(
        webhookRequest({ message: { chat: { id: CHAT_ID }, text: `/start ${token}` } }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: false, reason: "EXPIRED" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.skipIf(!dbAvailable)("binds the subscription from /start <token>", async () => {
    stubRouteEnv();
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
      expect(await response.json()).toEqual({ ok: true });
      const subs = await db.select().from(telegramSubscriptions);
      expect(subs).toHaveLength(1);
      expect(subs[0].positionId).toBe(POSITION_ID);
      expect(subs[0].chatId).toBe(CHAT_ID);
      expect(subs[0].telegramUsername).toBe("vindex_user");
      const tokens = await db.select().from(telegramConnectTokens).where(eq(telegramConnectTokens.tokenHash, hashConnectToken(token)));
      expect(tokens[0].consumedAt).not.toBeNull();
      expect(sendTelegramMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: CHAT_ID,
          text: "Vindex Telegram alerts are connected successfully.",
        }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.skipIf(!dbAvailable)("a second /start with the same token cannot rebind", async () => {
    stubRouteEnv();
    try {
      const { token } = await createConnectToken(db, POSITION_ID);
      await POST(webhookRequest({ message: { chat: { id: CHAT_ID }, text: `/start ${token}` } }));
      const second = await POST(webhookRequest({ message: { chat: { id: "99999" }, text: `/start ${token}` } }));
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ ok: false, reason: "CONSUMED" });
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
