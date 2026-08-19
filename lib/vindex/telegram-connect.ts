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
