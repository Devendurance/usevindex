import "server-only";

export const REQUIRED_ENV_VARS = ["BASE_SEPOLIA_RPC_URL", "KEEPERHUB_API_KEY"] as const;

export type VindexEnv = {
  baseSepoliaRpcUrl: string;
  keeperhubApiKey: string;
  keeperhubApiBaseUrl: string;
};

export class VindexEnvError extends Error {}

const KEEPERHUB_API_KEY_PATTERN = /^kh_[A-Za-z0-9_-]+$/;
const DEFAULT_KEEPERHUB_API_BASE_URL = "https://app.keeperhub.com";

function assertHttpUrl(value: string, variableName: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new VindexEnvError(
      `${variableName} must be a valid http(s) URL. Copy .env.example to .env and fill it in.`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new VindexEnvError(
      `${variableName} must be a valid http(s) URL. Copy .env.example to .env and fill it in.`,
    );
  }
}

export function getServerEnv(env: NodeJS.ProcessEnv = process.env): VindexEnv {
  const missing = REQUIRED_ENV_VARS.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new VindexEnvError(
      `Missing required environment variable(s): ${missing.join(", ")}. Copy .env.example to .env and fill it in.`,
    );
  }

  const baseSepoliaRpcUrl = env.BASE_SEPOLIA_RPC_URL!.trim();
  assertHttpUrl(baseSepoliaRpcUrl, "BASE_SEPOLIA_RPC_URL");

  const keeperhubApiKey = env.KEEPERHUB_API_KEY!.trim();
  if (!KEEPERHUB_API_KEY_PATTERN.test(keeperhubApiKey)) {
    throw new VindexEnvError(
      "KEEPERHUB_API_KEY must be a KeeperHub organisation API key (kh_ prefix). Create one at https://app.keeperhub.com -> avatar -> API Keys -> Organisation, then copy .env.example to .env and fill it in.",
    );
  }

  const keeperhubApiBaseUrl = env.KEEPERHUB_API_BASE_URL?.trim() || DEFAULT_KEEPERHUB_API_BASE_URL;
  assertHttpUrl(keeperhubApiBaseUrl, "KEEPERHUB_API_BASE_URL");

  return { baseSepoliaRpcUrl, keeperhubApiKey, keeperhubApiBaseUrl };
}

export function isServerEnvComplete(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    getServerEnv(env);
    return true;
  } catch (error) {
    if (error instanceof VindexEnvError) {
      return false;
    }
    throw error;
  }
}

export type TelegramEnv = {
  botToken: string;
  botUsername: string;
  webhookSecret: string;
};

// Telegram alerting is optional and best-effort: alerts never block the
// protection state machine, so these variables are NOT part of REQUIRED_ENV_VARS.
export function getTelegramEnv(env: NodeJS.ProcessEnv = process.env): TelegramEnv | null {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const botUsername = env.TELEGRAM_BOT_USERNAME?.trim();
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!botToken || !botUsername || !webhookSecret) return null;
  return { botToken, botUsername, webhookSecret };
}
