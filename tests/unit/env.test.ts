import { describe, expect, it } from "vitest";
import { getServerEnv, getTelegramEnv, isServerEnvComplete, VindexEnvError } from "../../lib/vindex/env";

const VALID_RPC_URL = "https://sepolia.base.org";
const VALID_API_KEY = "kh_ABCDEF0123456789";

/**
 * Build a full ProcessEnv: the installed @types/node declares NODE_ENV as a
 * required property, so partial literals do not satisfy the ProcessEnv type.
 */
function testEnv(overrides: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides };
}

function captureEnvError(env: NodeJS.ProcessEnv): VindexEnvError {
  try {
    getServerEnv(env);
  } catch (error) {
    expect(error).toBeInstanceOf(VindexEnvError);
    return error as VindexEnvError;
  }
  throw new Error("getServerEnv unexpectedly succeeded");
}

describe("getServerEnv", () => {
  it("throws listing the missing variable names for an empty env", () => {
    const error = captureEnvError(testEnv({}));
    expect(error.message).toContain("BASE_SEPOLIA_RPC_URL");
    expect(error.message).toContain("KEEPERHUB_API_KEY");
  });

  it("throws mentioning KEEPERHUB_API_KEY when only the RPC URL is provided", () => {
    const error = captureEnvError(testEnv({ BASE_SEPOLIA_RPC_URL: VALID_RPC_URL }));
    expect(error.message).toContain("KEEPERHUB_API_KEY");
  });

  it("rejects a non-URL BASE_SEPOLIA_RPC_URL", () => {
    expect(() =>
      getServerEnv(testEnv({ BASE_SEPOLIA_RPC_URL: "not-a-url", KEEPERHUB_API_KEY: VALID_API_KEY })),
    ).toThrow(VindexEnvError);
  });

  it("rejects a KEEPERHUB_API_KEY without the kh_ prefix without echoing its value", () => {
    const error = captureEnvError(
      testEnv({ BASE_SEPOLIA_RPC_URL: VALID_RPC_URL, KEEPERHUB_API_KEY: "secret123" }),
    );
    expect(error.message).toContain("kh_");
    expect(error.message).not.toContain("secret123");
  });

  it("resolves a valid env with the default base URL", () => {
    const env = getServerEnv(
      testEnv({ BASE_SEPOLIA_RPC_URL: VALID_RPC_URL, KEEPERHUB_API_KEY: VALID_API_KEY }),
    );
    expect(env).toEqual({
      baseSepoliaRpcUrl: VALID_RPC_URL,
      keeperhubApiKey: VALID_API_KEY,
      keeperhubApiBaseUrl: "https://app.keeperhub.com",
    });
  });

  it("respects a KEEPERHUB_API_BASE_URL override", () => {
    const env = getServerEnv(
      testEnv({
        BASE_SEPOLIA_RPC_URL: VALID_RPC_URL,
        KEEPERHUB_API_KEY: VALID_API_KEY,
        KEEPERHUB_API_BASE_URL: "https://keeperhub.example.com",
      }),
    );
    expect(env.keeperhubApiBaseUrl).toBe("https://keeperhub.example.com");
  });

  it("rejects an invalid KEEPERHUB_API_BASE_URL override", () => {
    expect(() =>
      getServerEnv(
        testEnv({
          BASE_SEPOLIA_RPC_URL: VALID_RPC_URL,
          KEEPERHUB_API_KEY: VALID_API_KEY,
          KEEPERHUB_API_BASE_URL: "not-a-url",
        }),
      ),
    ).toThrow(VindexEnvError);
  });

  it("never includes the api key value in any VindexEnvError message", () => {
    const scenarios: NodeJS.ProcessEnv[] = [
      testEnv({ KEEPERHUB_API_KEY: VALID_API_KEY }), // missing RPC URL
      testEnv({ BASE_SEPOLIA_RPC_URL: "not-a-url", KEEPERHUB_API_KEY: VALID_API_KEY }), // invalid RPC URL
      testEnv({
        BASE_SEPOLIA_RPC_URL: VALID_RPC_URL,
        KEEPERHUB_API_KEY: VALID_API_KEY,
        KEEPERHUB_API_BASE_URL: "not-a-url", // invalid base URL override
      }),
      testEnv({ BASE_SEPOLIA_RPC_URL: VALID_RPC_URL, KEEPERHUB_API_KEY: "bad-key" }), // invalid key shape
    ];
    for (const scenario of scenarios) {
      const error = captureEnvError(scenario);
      expect(error.message).not.toContain(VALID_API_KEY);
    }
  });
});

describe("isServerEnvComplete", () => {
  it("returns false for an empty env", () => {
    expect(isServerEnvComplete(testEnv({}))).toBe(false);
  });

  it("returns true for a valid env", () => {
    expect(
      isServerEnvComplete(
        testEnv({ BASE_SEPOLIA_RPC_URL: VALID_RPC_URL, KEEPERHUB_API_KEY: VALID_API_KEY }),
      ),
    ).toBe(true);
  });
});

describe("getTelegramEnv", () => {
  it("returns null when any Telegram variable is missing", () => {
    expect(getTelegramEnv(testEnv({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_BOT_USERNAME: "VindexAlertsBot" }))).toBeNull();
    expect(getTelegramEnv(testEnv({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_WEBHOOK_SECRET: "s" }))).toBeNull();
    expect(getTelegramEnv(testEnv({}))).toBeNull();
    expect(getTelegramEnv(testEnv({ TELEGRAM_BOT_TOKEN: "   ", TELEGRAM_BOT_USERNAME: "B", TELEGRAM_WEBHOOK_SECRET: "s" }))).toBeNull();
  });

  it("returns trimmed values when all three are set", () => {
    const env = getTelegramEnv(
      testEnv({
        TELEGRAM_BOT_TOKEN: " 123:abc ",
        TELEGRAM_BOT_USERNAME: " VindexAlertsBot ",
        TELEGRAM_WEBHOOK_SECRET: " long-random-secret ",
      }),
    );
    expect(env).toEqual({ botToken: "123:abc", botUsername: "VindexAlertsBot", webhookSecret: "long-random-secret" });
  });

  it("getServerEnv does not require Telegram variables", () => {
    expect(() =>
      getServerEnv(testEnv({ BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org", KEEPERHUB_API_KEY: "kh_test_key_123456" })),
    ).not.toThrow();
  });
});
