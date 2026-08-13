// Registers the Telegram Bot API webhook for this deployment AFTER the app is
// reachable over HTTPS. Never runs at application startup or build time.
// Never prints the bot token or the webhook secret.
//
// Usage: npm run telegram:webhook -- --url https://your-app.example
//        (or set APP_URL in the environment)

import "dotenv/config";

const argUrl = process.argv.find((arg) => arg.startsWith("--url="))?.slice("--url=".length);
const appUrl = (argUrl ?? process.env.APP_URL)?.trim();
const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

if (!appUrl) {
  console.error("APP_URL is required. Pass --url https://your-app.example or set APP_URL.");
  process.exit(1);
}
if (!botToken || !webhookSecret) {
  console.error("TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET must be set in .env.");
  process.exit(1);
}
if (!appUrl.startsWith("https://")) {
  console.error("Telegram requires an HTTPS webhook URL.");
  process.exit(1);
}

const url = `${appUrl.replace(/\/+$/, "")}/api/integrations/telegram/webhook`;
const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url, secret_token: webhookSecret }),
});
const body = (await response.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
if (!response.ok || body?.ok !== true) {
  console.error(`setWebhook failed: ${body?.description ?? String(response.status)}`);
  process.exit(1);
}
console.log(`Telegram webhook registered for ${url}.`);
console.log("The bot credentials were not printed.");
console.log("Users can now connect via Settings -> Telegram Alerts -> Connect Telegram.");
