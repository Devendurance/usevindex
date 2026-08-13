// P1 operator handoff: webhook registration is opt-in, HTTPS-only, and never
// exposes the bot token or webhook secret.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

describe("telegram webhook registration script", () => {
  it("is never invoked at startup or build time", async () => {
    const nextConfig = await readFile("next.config.ts", "utf8");
    const layout = await readFile("app/layout.tsx", "utf8");
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(nextConfig + layout).not.toMatch(/setWebhook|telegram:webhook/);
    expect(pkg.scripts["telegram:webhook"]).toBe("tsx scripts/register-telegram-webhook.ts");
    expect(Object.values(pkg.scripts).some((script) => script.includes("setWebhook"))).toBe(false);
  });

  it("registers the canonical webhook target and never prints secrets", async () => {
    const source = await readFile("scripts/register-telegram-webhook.ts", "utf8");
    expect(source).toContain("/api/integrations/telegram/webhook");
    expect(source).toContain("setWebhook");
    // The token and secret are used only inside the fetch body/URL.
    expect(source).not.toMatch(/console\.(log|info|error)\([^)]*token/i);
    expect(source).not.toMatch(/console\.(log|info|error)\([^)]*secret/i);
    expect(source).not.toMatch(/console\.(log|info|error)\(`[^`]*\$\{token\}[^`]*`/);
    expect(source).not.toMatch(/console\.(log|info|error)\(`[^`]*\$\{secret\}[^`]*`/);
  });

  it("accepts both --url forms used by operators", async () => {
    const source = await readFile("scripts/register-telegram-webhook.ts", "utf8");
    // Space form: npm run telegram:webhook -- --url https://your-app.example
    expect(source).toContain('"--url"');
    // Equals form: --url=https://your-app.example
    expect(source).toContain('"--url="');
  });

  it("documents the operator flow", async () => {
    const docs = await readFile("docs/telegram-alerts.md", "utf8");
    expect(docs).toContain("telegram:webhook");
    expect(docs).toContain("/api/integrations/telegram/webhook");
    expect(docs).toMatch(/APP_URL/);
  });
});
