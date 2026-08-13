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
// Kept as two parts so the full `.../bot<token>` path never appears as a
// literal in source; the bot token is appended at call time only.
const TELEGRAM_API_BASE = "https://api.telegram.org";

export const sendTelegramMessage = async (
  options: SendTelegramMessageOptions,
): Promise<TelegramSendResult> => {
  const { botToken, chatId, text, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
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
