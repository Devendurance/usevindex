// P1 Telegram transport: bounded, sanitized, never throws, never logs secrets.

import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

import { sendTelegramMessage } from "../../lib/telegram/client";

const BOT_TOKEN = "123456789:AA-test-token";
const CHAT_ID = "42424242";
const TEXT = "Vindex Telegram alerts are connected successfully.";

const okFetch = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("sendTelegramMessage", () => {
  it("returns the message id on success", async () => {
    const result = await sendTelegramMessage({
      botToken: BOT_TOKEN,
      chatId: CHAT_ID,
      text: TEXT,
      fetchImpl: okFetch({ ok: true, result: { message_id: 42 } }),
    });
    expect(result).toEqual({ ok: true, messageId: "42", errorCode: null });
  });

  it("maps HTTP failures to sanitized codes", async () => {
    const result = await sendTelegramMessage({
      botToken: BOT_TOKEN,
      chatId: CHAT_ID,
      text: TEXT,
      fetchImpl: okFetch({ ok: false, error_code: 403, description: "bot was blocked by the user" }, 403),
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("TELEGRAM_HTTP_403");
    expect(result.messageId).toBeNull();
  });

  it("maps network failures without leaking the URL", async () => {
    const result = await sendTelegramMessage({
      botToken: BOT_TOKEN,
      chatId: CHAT_ID,
      text: TEXT,
      fetchImpl: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    expect(result).toEqual({ ok: false, messageId: null, errorCode: "TELEGRAM_NETWORK" });
  });

  it("maps timeouts to TELEGRAM_TIMEOUT", async () => {
    const result = await sendTelegramMessage({
      botToken: BOT_TOKEN,
      chatId: CHAT_ID,
      text: TEXT,
      timeoutMs: 5,
      fetchImpl: vi.fn(
        (_url: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          }),
      ),
    });
    expect(result).toEqual({ ok: false, messageId: null, errorCode: "TELEGRAM_TIMEOUT" });
  });
});

describe("secret hygiene", () => {
  it("the client never logs the token or the request URL", async () => {
    const source = await readFile("lib/telegram/client.ts", "utf8");
    expect(source).not.toMatch(/console\./);
    expect(source).not.toMatch(/api\.telegram\.org\/bot/); // URL is constructed dynamically
  });
});
