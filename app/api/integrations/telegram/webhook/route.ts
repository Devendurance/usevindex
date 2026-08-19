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
