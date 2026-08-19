// P1 settings UX copy: connected/disconnected states derived from DB status.

import { describe, expect, it } from "vitest";

import { telegramConnectionCopy } from "../../components/forms/telegram-settings";

describe("telegramConnectionCopy", () => {
  it("unknown status shows the loading state", () => {
    const copy = telegramConnectionCopy(null);
    expect(copy.connected).toBe(false);
    expect(copy.blurb).toContain("Loading");
  });

  it("disconnected state advertises risk and withdrawal alerts", () => {
    const copy = telegramConnectionCopy({
      connected: false,
      telegramUsername: null,
      chatMasked: null,
      riskAlertsEnabled: true,
      withdrawalAlertsEnabled: true,
      lastDelivery: null,
    });
    expect(copy.connected).toBe(false);
    expect(copy.blurb).toContain("risk");
    expect(copy.blurb).toContain("withdrawal");
  });

  it("connected state names the username", () => {
    const copy = telegramConnectionCopy({
      connected: true,
      telegramUsername: "vindex_user",
      chatMasked: null,
      riskAlertsEnabled: true,
      withdrawalAlertsEnabled: true,
      lastDelivery: null,
    });
    expect(copy.connected).toBe(true);
    expect(copy.blurb).toContain("@vindex_user");
  });

  it("connected state falls back to the masked chat id", () => {
    const copy = telegramConnectionCopy({
      connected: true,
      telegramUsername: null,
      chatMasked: "42…4242",
      riskAlertsEnabled: true,
      withdrawalAlertsEnabled: true,
      lastDelivery: null,
    });
    expect(copy.blurb).toContain("42…4242");
  });
});
