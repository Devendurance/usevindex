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
