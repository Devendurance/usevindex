import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const routes = [
  "/",
  "/setup",
  "/settings",
  "/monitor",
  "/confirm",
  "/demo",
  "/simulation/preview",
  "/evacuation/preview",
  "/receipt/preview",
  "/audit/preview",
  "/outcome/preview",
];

test.describe("Vindex routes", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/**", (route) => route.abort());
  });

  test("all planned routes render a meaningful page", async ({ page }) => {
    for (const route of routes) {
      await page.goto(route, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await expect(page.locator('[data-page-ready="true"]')).toBeVisible();
      await expect(page.locator("main h1")).toHaveCount(1);
      await expect(page.locator("body")).not.toContainText("Application error");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
    }
  });

  test("hero preserves the approved quiet hierarchy", async ({ page }) => {
    await page.goto("/");
    const hero = page.locator(".marketing-hero");
    await expect(hero).toContainText("DETECT THE THREAT.");
    await expect(hero).toContainText("EXECUTE THE ESCAPE.");
    await expect(hero.getByText("Vindex watches supported DeFi positions, confirms converging danger and routes a verified exit through KeeperHub.")).toBeVisible();
    await expect(hero.getByRole("link", { name: "RUN A DRY RUN" })).toHaveAttribute("href", "/setup");
    await expect(hero.locator(".primary-cta")).toHaveCount(1);
    await expect(hero.locator(".protected-route")).toHaveCount(1);
    await expect(hero.locator(".proof-point")).toHaveCount(3);
    await expect(hero).not.toContainText("SIMULATION ONLY");
    await expect(hero).not.toContainText("Rescue Receipt");
  });

  test("hero follows the approved route-first DOM order", async ({ page }) => {
    await page.goto("/");
    const order = await page.locator(".marketing-hero__inner").evaluate((hero) =>
      Array.from(hero.children).map((child) => {
        if (child.matches("h1")) return "headline";
        if (child.matches(".marketing-hero__route")) return "route";
        if (child.matches(".marketing-hero__copy")) return "supporting-copy";
        if (child.matches(".primary-cta")) return "primary-cta";
        if (child.matches(".proof-row")) return "proof-row";
        return "other";
      }),
    );

    expect(order).toEqual(["headline", "route", "supporting-copy", "primary-cta", "proof-row"]);
  });

  test("desktop hero includes a down indicator linked to how it works", async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) <= 900, "desktop-only hero affordance");
    await page.goto("/");

    const indicator = page.locator('.marketing-hero a.down-indicator[href="#how-it-works"]');
    await expect(indicator).toBeVisible();
  });

  test("proof row uses three black square arrow tiles", async ({ page }) => {
    await page.goto("/");

    const proofPoints = page.locator(".proof-row > .proof-point");
    const arrowTiles = proofPoints.locator(".arrow-tile");
    await expect(proofPoints).toHaveCount(3);
    await expect(arrowTiles).toHaveCount(3);
    for (let index = 0; index < 3; index += 1) {
      await expect(proofPoints.nth(index).locator(".arrow-tile")).toHaveCount(1);
    }

    const tileStyles = await arrowTiles.evaluateAll((tiles) =>
      tiles.map((tile) => {
        const style = getComputedStyle(tile);
        return {
          backgroundColor: style.backgroundColor,
          height: Number.parseFloat(style.height),
          width: Number.parseFloat(style.width),
        };
      }),
    );

    for (const style of tileStyles) {
      expect(style.backgroundColor).toBe("rgb(17, 17, 17)");
      expect(style.width).toBe(style.height);
    }
  });

  test("primary and secondary buttons keep square corners", async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) <= 900, "desktop navigation button is hidden on mobile");
    await page.goto("/");

    const primaryRadius = await page.locator(".marketing-hero .primary-cta").evaluate((button) =>
      Number.parseFloat(getComputedStyle(button).borderTopLeftRadius),
    );
    const secondaryRadius = await page.locator(".site-nav__demo.secondary-button").evaluate((button) =>
      Number.parseFloat(getComputedStyle(button).borderTopLeftRadius),
    );

    expect.soft(primaryRadius, "primary button radius").toBeLessThanOrEqual(1);
    expect.soft(secondaryRadius, "secondary button radius").toBeLessThanOrEqual(1);
  });

  test("View demo uses the layered secondary treatment", async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) <= 900, "desktop navigation button is hidden on mobile");
    await page.goto("/");

    await expect(page.locator(".site-nav__demo")).toHaveClass(/\bsecondary-button--layered\b/);
  });

  test("desktop navigation marks View demo as the current page", async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) <= 900, "desktop navigation is hidden on mobile");
    await page.goto("/demo");

    await expect(page.locator(".site-nav__demo")).toHaveAttribute("aria-current", "page");
  });

  test("setup validates locally and never submits unavailable actions", async ({ page }) => {
    await page.goto("/setup");
    const wallet = page.getByLabel("Safe wallet");
    await wallet.fill("0x-invalid");
    await wallet.blur();
    await expect(wallet).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("button", { name: "Save configuration" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Arm position" })).toBeDisabled();
    await expect(page.locator("body")).toContainText("live validation");
  });

  test("mobile navigation is keyboard reachable and responds locally", async ({ page }) => {
    test.skip((await page.evaluate(() => window.innerWidth)) > 900, "mobile menu is collapsed only on small viewports");
    await page.goto("/");
    const menu = page.getByRole("button", { name: "Open navigation" });
    await menu.focus();
    await expect(menu).toBeFocused();
    await menu.press("Enter");
    await expect(page.getByRole("button", { name: "Close navigation" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toContainText("View demo");
    await page.getByRole("link", { name: "View demo" }).last().click();
    await expect(page).toHaveURL(/\/demo$/);
  });

  test("mobile navigation closes on Escape and returns focus to its menu button", async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) > 900, "mobile menu is collapsed only on small viewports");
    await page.goto("/");

    const menuButton = page.getByRole("button", { name: "Open navigation" });
    await menuButton.click();
    const mobileNavigation = page.getByRole("navigation", { name: "Mobile navigation" });
    const firstLink = mobileNavigation.getByRole("link").first();
    await firstLink.focus();
    await expect(firstLink).toBeFocused();

    await page.keyboard.press("Escape");

    await expect(menuButton).toHaveAttribute("aria-expanded", "false");
    await expect(menuButton).toBeFocused();
  });

  test("preview routes never render fabricated evidence or browser persistence", async ({ page }) => {
    const storageWrites: string[] = [];
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        window.dispatchEvent(new CustomEvent("vindex-storage-write", { detail: { key, value } }));
        return original.call(this, key, value);
      };
    });
    await page.exposeFunction("recordStorageWrite", (payload: { key: string }) => storageWrites.push(payload.key));
    await page.addInitScript(() => {
      window.addEventListener("vindex-storage-write", (event) => {
        const recorder = (window as unknown as { recordStorageWrite?: (payload: unknown) => void }).recordStorageWrite;
        recorder?.((event as CustomEvent).detail);
      });
    });
    for (const route of routes.slice(6)) {
      await page.goto(route, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const text = await page.locator("body").innerText();
      expect(text).not.toMatch(/0x[a-fA-F0-9]{8,}/);
      expect(text).not.toMatch(/\$\s?\d/);
      expect(text).not.toMatch(/\b(?:19|20)\d{2}-\d{2}-\d{2}\b/);
      expect(text).not.toContain("VINDEX RESCUE / 00041");
      if (route === "/receipt/preview") {
        // The receipt route is now live: an unknown id renders an honest
        // "not available" empty state instead of the old static placeholder.
        await expect(page.locator("body")).toContainText(/does not exist|could not be loaded/);
        continue;
      } else {
        expect(text).toContain("—");
      }
    }
    expect(storageWrites).toEqual([]);
  });

  test("controlled preview states render without live evidence", async ({ page }) => {
    const stateRoutes = [
      ["/confirm?state=confirming", "Confirmation in progress"],
      ["/simulation/preview?state=simulating", "SIMULATING"],
      ["/evacuation/preview?state=executing", "EXECUTING"],
      ["/outcome/preview?state=blocked", "BLOCKED"],
      ["/outcome/preview?state=failed", "FAILED"],
      ["/outcome/preview?state=execution_unknown", "EXECUTION_UNKNOWN"],
      ["/outcome/preview?state=intervention_required", "INTERVENTION_REQUIRED"],
    ] as const;

    for (const [route, expected] of stateRoutes) {
      await page.goto(route, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await expect(page.locator("body")).toContainText(expected);
      await expect(page.locator("body")).toContainText("—");
      const bodyText = await page.locator("body").innerText();
      expect(bodyText).not.toMatch(/0x[a-fA-F0-9]{8,}/);
    }
  });

  test("reduced motion keeps content complete", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.locator(".protected-route").first()).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto");
  });

  test("desktop surfaces have no serious accessibility violations", async ({ page }) => {
    await page.goto("/monitor");
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious");
    expect(serious).toEqual([]);
  });

});

test.describe("M3 live dashboard", () => {
  const LIVE_MODEL = {
    position: {
      chainId: 84532,
      networkName: "Base Sepolia",
      protocol: "Aave V3",
      asset: {
        symbol: "USDC",
        label: "USDC — Aave Base Sepolia test asset",
        address: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
        decimals: 6,
      },
      positionToken: { symbol: "aUSDC", address: "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC" },
      executionWallet: "0x675638ddbbf8b70b906d68e3485da72c6c63d130",
      safeWallet: "0xC44685b7c78cC9C9b7f6623d7697Ac30ab0D6Dc9",
      suppliedBalance: { baseUnits: "5000017", formatted: "5.000017" },
      executionWalletUsdcBalance: { baseUnits: "0", formatted: "0" },
      executionWalletNativeBalance: { wei: "20000000000000000", formatted: "0.02" },
      safeWalletUsdcBalance: { baseUnits: "0", formatted: "0" },
      blockNumber: "45384000",
      blockTimestamp: "2026-08-12T12:00:00.000Z",
      observedAt: "2026-08-12T12:00:30.000Z",
    },
    readiness: {
      networkValid: true,
      contractsValid: true,
      executionWalletValid: true,
      positionExists: true,
      safeWalletConfigured: true,
      safeWalletValid: true,
      keeperHubHealthy: true,
      readyForMonitoring: true,
    },
    freshness: "live",
    diagnostics: [],
  };

  const NO_SAFE_WALLET_MODEL = {
    ...LIVE_MODEL,
    position: { ...LIVE_MODEL.position, safeWallet: null, safeWalletUsdcBalance: null },
    readiness: {
      ...LIVE_MODEL.readiness,
      safeWalletConfigured: false,
      safeWalletValid: false,
      readyForMonitoring: false,
    },
  };

  const STALE_MODEL = {
    ...LIVE_MODEL,
    freshness: "stale",
    diagnostics: ["Showing the last persisted snapshot — live data is currently unavailable."],
    readiness: { ...LIVE_MODEL.readiness, contractsValid: false, readyForMonitoring: false },
  };

  const mockCurrent = (page: import("@playwright/test").Page, model: unknown) => {
    return page.route("**/api/vindex/positions/current", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(model) }),
    );
  };

  test("A. renders the live position with exact testnet labeling", async ({ page }) => {
    await mockCurrent(page, LIVE_MODEL);
    await page.goto("/monitor", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText("Base Sepolia");
    await expect(page.locator("body")).toContainText("Aave V3");
    await expect(page.locator("body")).toContainText("USDC — Aave Base Sepolia test asset");
    await expect(page.locator("body")).toContainText("5.000017 USDC test position");
    await expect(page.locator("body")).toContainText("READY FOR MONITORING");
    await expect(page.locator("body")).toContainText("LIVE");
    await expect(page.locator("body")).not.toContainText("EVACUATING");
    await expect(page.locator("body")).not.toContainText("PROTECTED");
    await expect(page.locator("body")).not.toContainText("$");
  });

  test("B. shows SAFE WALLET REQUIRED when no safe wallet is configured", async ({ page }) => {
    await mockCurrent(page, NO_SAFE_WALLET_MODEL);
    await page.goto("/monitor", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText("SAFE WALLET REQUIRED");
    await expect(page.locator("body")).toContainText("Not configured");
    await expect(page.locator("body")).not.toContainText("READY FOR MONITORING");
  });

  test("C. shows the configured safe wallet when present", async ({ page }) => {
    await mockCurrent(page, LIVE_MODEL);
    await page.goto("/monitor", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText("C446");
  });

  test("D. marks stale data and shows diagnostics", async ({ page }) => {
    await mockCurrent(page, STALE_MODEL);
    await page.goto("/monitor", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText("STALE");
    await expect(page.locator("body")).toContainText("last persisted snapshot");
    await expect(page.locator("body")).not.toContainText("READY FOR MONITORING");
  });

  test("E. shows an unavailable/error state without fabricated values", async ({ page }) => {
    await page.route("**/api/vindex/positions/current", (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "RPC_UNAVAILABLE", message: "The Base Sepolia RPC is unavailable." }) }),
    );
    await page.goto("/monitor", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText("UNAVAILABLE");
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/0x[a-fA-F0-9]{8,}/);
    expect(text).not.toMatch(/\$\s?\d/);
  });

  test("F. setup form persists the safe wallet via the API", async ({ page }) => {
    let putBody: { safeWallet?: string } | null = null;
    await page.route("**/api/vindex/config", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ safeWallet: null, configured: false, chainId: 84532, executionWallet: "0x675638ddbbf8b70b906d68e3485da72c6c63d130", configuredAt: null, updatedAt: null }),
        });
        return;
      }
      putBody = JSON.parse(route.request().postData() ?? "{}") as { safeWallet?: string } | null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ safeWallet: putBody?.safeWallet ?? null, configured: true, chainId: 84532, executionWallet: "0x675638ddbbf8b70b906d68e3485da72c6c63d130", configuredAt: "2026-08-12T12:00:00.000Z", updatedAt: "2026-08-12T12:00:00.000Z" }),
      });
    });
    await page.goto("/setup", { waitUntil: "domcontentloaded" });
    await expect(page.getByLabel("Safe wallet")).toHaveValue("");
    await page.getByLabel("Safe wallet").fill("0xC44685b7c78cC9C9b7f6623d7697Ac30ab0D6Dc9");
    await expect(page.getByRole("button", { name: "Save configuration" })).toBeEnabled();
    await page.getByRole("button", { name: "Save configuration" }).click();
    await expect(page.locator("body")).toContainText("Saved at");
    expect(putBody).toEqual({ safeWallet: "0xC44685b7c78cC9C9b7f6623d7697Ac30ab0D6Dc9" });
});

test.describe("M4 live signal evidence", () => {
  const POSITION_MODEL = {
    position: {
      chainId: 84532,
      networkName: "Base Sepolia",
      protocol: "Aave V3",
      asset: { symbol: "USDC", label: "USDC — Aave Base Sepolia test asset", address: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", decimals: 6 },
      positionToken: { symbol: "aUSDC", address: "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC" },
      executionWallet: "0x675638ddbbf8b70b906d68e3485da72c6c63d130",
      safeWallet: "0xC44685b7c78cC9C9b7f6623d7697Ac30ab0D6Dc9",
      suppliedBalance: { baseUnits: "5000017", formatted: "5.000017" },
      executionWalletUsdcBalance: { baseUnits: "0", formatted: "0" },
      executionWalletNativeBalance: { wei: "20000000000000000", formatted: "0.02" },
      safeWalletUsdcBalance: { baseUnits: "0", formatted: "0" },
      blockNumber: "45384000",
      blockTimestamp: "2026-08-12T12:00:00.000Z",
      observedAt: "2026-08-12T12:00:30.000Z",
    },
    readiness: { networkValid: true, contractsValid: true, executionWalletValid: true, positionExists: true, safeWalletConfigured: true, safeWalletValid: true, keeperHubHealthy: true, readyForMonitoring: true },
    freshness: "live",
    diagnostics: [],
  };

  const SIGNALS_LIVE = {
    freshness: "LIVE",
    latest: [
      { sourceFamily: "ORACLE_PRICE_STATE", metric: "AAVE_USDC_ORACLE_PRICE", rawValue: "99979128", normalizedValue: "99979128", contractAddress: "0x943b0dE18d4abf4eF02A85912F8fc07684C141dF", blockNumber: "45384001", blockTimestamp: "2026-08-12T12:00:06.000Z", observedAt: "2026-08-12T12:00:30.000Z", metadata: { formatted: "0.99979128", label: "Aave Oracle Price State/Change" } },
      { sourceFamily: "AAVE_RESERVE_STATE", metric: "AAVE_RESERVE_LIQUIDITY_RATE", rawValue: "22017985532403510445356237", normalizedValue: "22017985532403510445356237", contractAddress: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27", blockNumber: "45384001", blockTimestamp: "2026-08-12T12:00:06.000Z", observedAt: "2026-08-12T12:00:30.000Z", metadata: { formatted: "0.02201798553240351", label: "per-second liquidity rate" } },
      { sourceFamily: "POSITION_STATE", metric: "POSITION_AUSDC_BALANCE", rawValue: "5000017", normalizedValue: "5000017", contractAddress: "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC", blockNumber: "45384001", blockTimestamp: "2026-08-12T12:00:06.000Z", observedAt: "2026-08-12T12:00:30.000Z", metadata: { formatted: "5.000017", owner: "0x675638ddbbf8b70b906d68e3485da72c6c63d130" } },
    ],
  };

  const mockApi = (page: import("@playwright/test").Page, signals: unknown) => {
    return Promise.all([
      page.route("**/api/vindex/positions/current", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(POSITION_MODEL) }),
      ),
      page.route("**/api/vindex/signals/latest", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(signals) }),
      ),
    ]);
  };

  test("oracle/reserve/position signal evidence renders with provenance", async ({ page }) => {
    await mockApi(page, SIGNALS_LIVE);
    await page.goto("/monitor", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText("LIVE OBSERVATIONS");
    await expect(page.locator("body")).toContainText("AAVE_USDC_ORACLE_PRICE");
    await expect(page.locator("body")).toContainText("AAVE_RESERVE_LIQUIDITY_RATE");
    await expect(page.locator("body")).toContainText("POSITION_AUSDC_BALANCE");
    await expect(page.locator("body")).toContainText("0.99979128 (USD, 8 decimals)");
    await expect(page.locator("body")).toContainText("45384001");
    await expect(page.locator("body")).toContainText("2026-08-12T12:00:06.000Z");
  });

  test("signal evidence never claims threat states", async ({ page }) => {
    await mockApi(page, SIGNALS_LIVE);
    await page.goto("/monitor", { waitUntil: "domcontentloaded" });
    const text = await page.locator("body").innerText();
    expect(text).not.toContain("THREAT DETECTED");
    expect(text).not.toContain("CRITICAL");
    expect(text).not.toMatch(/\bRED\b/);
    expect(text).not.toContain("PROTECTED");
  });

  test("stale signals are marked STALE", async ({ page }) => {
    await mockApi(page, { ...SIGNALS_LIVE, freshness: "STALE" });
    await page.goto("/monitor", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText("STALE");
  });

  test("unavailable signals render an honest empty state", async ({ page }) => {
    await page.route("**/api/vindex/positions/current", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(POSITION_MODEL) }),
    );
    await page.route("**/api/vindex/signals/latest", (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "LIVE_READ_FAILED", message: "unavailable" }) }),
    );
    await page.goto("/monitor", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText("Signal evidence is unavailable until the first collection completes");
  });
});

test.describe("M5 policy + consensus", () => {
  const POSITION_MODEL = {
    position: {
      chainId: 84532,
      networkName: "Base Sepolia",
      protocol: "Aave V3",
      asset: { symbol: "USDC", label: "USDC — Aave Base Sepolia test asset", address: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", decimals: 6 },
      positionToken: { symbol: "aUSDC", address: "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC" },
      executionWallet: "0x675638ddbbf8b70b906d68e3485da72c6c63d130",
      safeWallet: "0xC44685b7c78cC9C9b7f6623d7697Ac30ab0D6Dc9",
      suppliedBalance: { baseUnits: "5000017", formatted: "5.000017" },
      executionWalletUsdcBalance: { baseUnits: "0", formatted: "0" },
      executionWalletNativeBalance: { wei: "20000000000000000", formatted: "0.02" },
      safeWalletUsdcBalance: { baseUnits: "0", formatted: "0" },
      blockNumber: "45384000",
      blockTimestamp: "2026-08-12T12:00:00.000Z",
      observedAt: "2026-08-12T12:00:30.000Z",
    },
    readiness: { networkValid: true, contractsValid: true, executionWalletValid: true, positionExists: true, safeWalletConfigured: true, safeWalletValid: true, keeperHubHealthy: true, readyForMonitoring: true },
    freshness: "live",
    diagnostics: [],
  };

  const SIGNALS_LIVE = {
    freshness: "LIVE",
    latest: [
      { sourceFamily: "ORACLE_PRICE_STATE", metric: "AAVE_USDC_ORACLE_PRICE", rawValue: "99979128", normalizedValue: "99979128", contractAddress: "0x943b0dE18d4abf4eF02A85912F8fc07684C141dF", blockNumber: "45384001", blockTimestamp: "2026-08-12T12:00:06.000Z", observedAt: "2026-08-12T12:00:30.000Z", metadata: { formatted: "0.99979128" } },
      { sourceFamily: "AAVE_RESERVE_STATE", metric: "AAVE_RESERVE_LIQUIDITY_RATE", rawValue: "22017985532403510445356237", normalizedValue: "22017985532403510445356237", contractAddress: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27", blockNumber: "45384001", blockTimestamp: "2026-08-12T12:00:06.000Z", observedAt: "2026-08-12T12:00:30.000Z", metadata: { formatted: "0.022" } },
      { sourceFamily: "POSITION_STATE", metric: "POSITION_AUSDC_BALANCE", rawValue: "5000017", normalizedValue: "5000017", contractAddress: "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC", blockNumber: "45384001", blockTimestamp: "2026-08-12T12:00:06.000Z", observedAt: "2026-08-12T12:00:30.000Z", metadata: { formatted: "5.000017" } },
    ],
  };

  const WATCHING_DECISION = {
    positionId: "base-sepolia:aave-v3:usdc:0x675638ddbbf8b70b906d68e3485da72c6c63d130",
    state: "WATCHING",
    policy: { id: "p1", mode: "STANDARD", version: 1, requiredSignals: 2, correlationWindowSec: 600, safeWalletSnapshot: "0xC44685b7c78cC9C9b7f6623d7697Ac30ab0D6Dc9", isArmed: true },
    matchedFamilies: [
      { family: "ORACLE_PRICE_STATE", matched: false, reason: "Aave USDC oracle price 99979128 (8 decimals) is inside 0.97-1.03 USD.", observationIds: [], values: { raw: "99979128" } },
      { family: "AAVE_RESERVE_STATE", matched: false, reason: "Aave reserve supplied state is stable.", observationIds: [], values: {} },
      { family: "POSITION_STATE", matched: false, reason: "Protected aUSDC balance is stable.", observationIds: [], values: {} },
    ],
    matchedCount: 0,
    decisionId: null,
    windowStartedAt: null,
    confirmedAt: null,
    expiresAt: null,
    readyForSimulation: false,
    lastEvaluatedAt: "2026-08-12T12:00:30.000Z",
    drill: false,
    drillLabel: null,
    drillExplanation: null,
    reRead: null,
  };

  const DRILL_CONFIRMING_DECISION = {
    ...WATCHING_DECISION,
    state: "CONFIRMING",
    policy: { ...WATCHING_DECISION.policy, id: "p2", mode: "DRILL_HIGH_SENSITIVITY", version: 2 },
    matchedFamilies: [
      { family: "ORACLE_PRICE_STATE", matched: true, reason: "DRILL condition: Aave USDC oracle price 99979128 (8 decimals) <= 1.01 USD.", observationIds: ["obs1"], values: { raw: "99979128", block: "45384001" } },
      { family: "AAVE_RESERVE_STATE", matched: true, reason: "DRILL condition: Aave USDC reserve variable debt 6154634874505 > 0.", observationIds: ["obs2"], values: { raw: "6154634874505", block: "45384001" } },
      { family: "POSITION_STATE", matched: true, reason: "DRILL condition: protected aUSDC balance 5000065 > 0.", observationIds: ["obs3"], values: { raw: "5000065", block: "45384001" } },
    ],
    matchedCount: 3,
    decisionId: "d2",
    windowStartedAt: "2026-08-12T12:00:10.000Z",
    confirmedAt: "2026-08-12T12:00:20.000Z",
    expiresAt: "2026-08-12T13:00:20.000Z",
    readyForSimulation: true,
    drill: true,
    drillLabel: "PROTECTION DRILL — HIGH-SENSITIVITY POLICY",
    drillExplanation: "Real measurements with intentionally sensitive thresholds. This is a protection drill, not evidence of an Aave exploit.",
    reRead: { outcome: "passed", blockNumber: "45384010", reason: null },
  };

  const mockAll = (page: import("@playwright/test").Page, decision: unknown) => {
    return Promise.all([
      page.route("**/api/vindex/positions/current", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(POSITION_MODEL) }),
      ),
      page.route("**/api/vindex/signals/latest", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SIGNALS_LIVE) }),
      ),
      page.route("**/api/vindex/decisions/current", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(decision) }),
      ),
      page.route("**/api/vindex/executions/prepared", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ preparation: null, execution: null }) }),
      ),
      page.route("**/api/vindex/receipts/current", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ receipt: null }) }),
      ),
    ]);
  };

  test("STANDARD policy renders WATCHING with matched evidence", async ({ page }) => {
    await mockAll(page, WATCHING_DECISION);
    await page.goto("/monitor", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText("PROTECTION STATE");
    await expect(page.locator("body")).toContainText("WATCHING");
    await expect(page.locator("body")).toContainText("STANDARD");
    await expect(page.locator("body")).toContainText("v1");
    await expect(page.locator("body")).toContainText("0 / 2");
  });

  test("DRILL badge and confirmed CONFIRMING state render honestly", async ({ page }) => {
    await mockAll(page, DRILL_CONFIRMING_DECISION);
    await page.goto("/monitor", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText("CONFIRMING");
    await expect(page.locator("body")).toContainText("PROTECTION DRILL — HIGH-SENSITIVITY POLICY");
    await expect(page.locator("body")).toContainText("not evidence of an Aave exploit");
    await expect(page.locator("body")).toContainText("3 / 2");
    await expect(page.locator("body")).toContainText("DRILL condition: Aave USDC oracle price 99979128");
    await expect(page.locator("body")).toContainText("passed");
    const text = await page.locator("body").innerText();
    expect(text).not.toContain("EVACUATING");
    expect(text).not.toContain("PROTECTED");
    expect(text).not.toContain("Aave is being hacked");
  });
});

test.describe("M6 exit preparation", () => {
  const POSITION_MODEL = {
    position: {
      chainId: 84532,
      networkName: "Base Sepolia",
      protocol: "Aave V3",
      asset: { symbol: "USDC", label: "USDC — Aave Base Sepolia test asset", address: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", decimals: 6 },
      positionToken: { symbol: "aUSDC", address: "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC" },
      executionWallet: "0x675638ddbbf8b70b906d68e3485da72c6c63d130",
      safeWallet: "0xC44685b7c78cC9C9b7f6623d7697Ac30ab0D6Dc9",
      suppliedBalance: { baseUnits: "5000017", formatted: "5.000017" },
      executionWalletUsdcBalance: { baseUnits: "0", formatted: "0" },
      executionWalletNativeBalance: { wei: "20000000000000000", formatted: "0.02" },
      safeWalletUsdcBalance: { baseUnits: "0", formatted: "0" },
      blockNumber: "45384000",
      blockTimestamp: "2026-08-12T12:00:00.000Z",
      observedAt: "2026-08-12T12:00:30.000Z",
    },
    readiness: { networkValid: true, contractsValid: true, executionWalletValid: true, positionExists: true, safeWalletConfigured: true, safeWalletValid: true, keeperHubHealthy: true, readyForMonitoring: true },
    freshness: "live",
    diagnostics: [],
  };

  const DRILL_DECISION = {
    positionId: "base-sepolia:aave-v3:usdc:0x675638ddbbf8b70b906d68e3485da72c6c63d130",
    state: "CONFIRMING",
    policy: { id: "p2", mode: "DRILL_HIGH_SENSITIVITY", version: 2, requiredSignals: 2, correlationWindowSec: 600, safeWalletSnapshot: "0xC44685b7c78cC9C9b7f6623d7697Ac30ab0D6Dc9", isArmed: true },
    matchedFamilies: [],
    matchedCount: 3,
    decisionId: "d2",
    windowStartedAt: "2026-08-12T12:00:10.000Z",
    confirmedAt: "2026-08-12T12:00:20.000Z",
    expiresAt: "2026-08-12T13:00:20.000Z",
    readyForSimulation: true,
    drill: true,
    drillLabel: "PROTECTION DRILL — HIGH-SENSITIVITY POLICY",
    drillExplanation: "Real measurements with intentionally sensitive thresholds. This is a protection drill, not evidence of an Aave exploit.",
    reRead: { outcome: "passed", blockNumber: "45384010", reason: null },
  };

  const SIMULATION_PASSED_PREP = {
    executionId: "e1",
    decisionId: "d2",
    simulationId: "s1",
    state: "SIMULATION_PASSED",
    target: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
    asset: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
    amountMode: "FULL_POSITION",
    amountBaseUnits: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
    safeWallet: "0xC44685b7c78cC9C9b7f6623d7697Ac30ab0D6Dc9",
    gasEstimate: "183705",
    expectedWithdrawAmount: "5000077",
    blockNumber: "45384020",
    blockTimestamp: "2026-08-12T12:00:40.000Z",
    simulatedAt: "2026-08-12T12:00:45.000Z",
    parametersHash: "16c7a4652c1dddb9",
    readyForExecution: true,
    errorCode: null,
  };

  const BLOCKED_PREP = { ...SIMULATION_PASSED_PREP, state: "BLOCKED", readyForExecution: false, errorCode: "SIMULATION_FAILED", simulationId: null, expectedWithdrawAmount: null, gasEstimate: null };

  const mockAll = (page: import("@playwright/test").Page, preparation: unknown) => {
    return Promise.all([
      page.route("**/api/vindex/positions/current", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(POSITION_MODEL) }),
      ),
      page.route("**/api/vindex/decisions/current", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(DRILL_DECISION) }),
      ),
      page.route("**/api/vindex/executions/prepared", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ preparation, execution: null }) }),
      ),
      page.route("**/api/vindex/receipts/current", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ receipt: null }) }),
      ),
    ]);
  };

  test("SIMULATION_PASSED preparation renders honestly without funds-moved claims", async ({ page }) => {
    await mockAll(page, SIMULATION_PASSED_PREP);
    await page.goto("/monitor", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText("EXIT PREPARATION");
    await expect(page.locator("body")).toContainText("Ready for execution");
    await expect(page.locator("body")).toContainText("SIMULATION PASSED");
    await expect(page.locator("body")).toContainText("Exit validation");
    await expect(page.locator("body")).toContainText("FULL_POSITION");
    await expect(page.locator("body")).toContainText("No funds have moved");
    await expect(page.locator("body")).toContainText("PROTECTION DRILL — HIGH-SENSITIVITY POLICY");
    const text = await page.locator("body").innerText();
    expect(text).not.toContain("EVACUATING");
    expect(text).not.toContain("PROTECTED");
    expect(text).not.toContain("$");
  });

  test("BLOCKED preparation shows the failure state without funds-moved claims", async ({ page }) => {
    await mockAll(page, BLOCKED_PREP);
    await page.goto("/monitor", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText("Blocked");
    await expect(page.locator("body")).toContainText("SIMULATION_FAILED");
    await expect(page.locator("body")).toContainText("No funds have moved");
    const text = await page.locator("body").innerText();
    expect(text).not.toContain("EVACUATING");
    expect(text).not.toContain("PROTECTED");
  });
});

test.describe("M7 evacuation execution", () => {
  const POSITION_MODEL = {
    position: {
      chainId: 84532,
      networkName: "Base Sepolia",
      protocol: "Aave V3",
      asset: { symbol: "USDC", label: "USDC — Aave Base Sepolia test asset", address: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", decimals: 6 },
      positionToken: { symbol: "aUSDC", address: "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC" },
      executionWallet: "0x675638ddbbf8b70b906d68e3485da72c6c63d130",
      safeWallet: "0xC44685b7c78cC9C9b7f6623d7697Ac30ab0D6Dc9",
      suppliedBalance: { baseUnits: "0", formatted: "0" },
      executionWalletUsdcBalance: { baseUnits: "0", formatted: "0" },
      executionWalletNativeBalance: { wei: "20000000000000000", formatted: "0.02" },
      safeWalletUsdcBalance: { baseUnits: "0", formatted: "0" },
      blockNumber: "45384000",
      blockTimestamp: "2026-08-12T12:00:00.000Z",
      observedAt: "2026-08-12T12:00:30.000Z",
    },
    readiness: { networkValid: true, contractsValid: true, executionWalletValid: true, positionExists: false, safeWalletConfigured: true, safeWalletValid: true, keeperHubHealthy: true, readyForMonitoring: false },
    freshness: "live",
    diagnostics: [],
  };

  const DRILL_DECISION = {
    positionId: "base-sepolia:aave-v3:usdc:0x675638ddbbf8b70b906d68e3485da72c6c63d130",
    state: "CONFIRMING",
    policy: { id: "p2", mode: "DRILL_HIGH_SENSITIVITY", version: 2, requiredSignals: 2, correlationWindowSec: 600, safeWalletSnapshot: "0xC44685b7c78cC9C9b7f6623d7697Ac30ab0D6Dc9", isArmed: true },
    matchedFamilies: [],
    matchedCount: 3,
    decisionId: "d2",
    windowStartedAt: "2026-08-12T12:00:10.000Z",
    confirmedAt: "2026-08-12T12:00:20.000Z",
    expiresAt: "2026-08-12T13:00:20.000Z",
    readyForSimulation: true,
    drill: true,
    drillLabel: "PROTECTION DRILL — HIGH-SENSITIVITY POLICY",
    drillExplanation: "Real measurements with intentionally sensitive thresholds. This is a protection drill, not evidence of an Aave exploit.",
    reRead: { outcome: "passed", blockNumber: "45384010", reason: null },
  };

  const executionOf = (outcome: string, overrides: Record<string, unknown> = {}) => ({
    outcome,
    executionId: "e7",
    decisionId: "d2",
    keeperhubExecutionId: "direct_evac_1",
    status: "completed",
    transactionHash: outcome === "EXECUTED_VERIFYING_DESTINATION" ? "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a" : null,
    transactionLink: outcome === "EXECUTED_VERIFYING_DESTINATION" ? "https://sepolia.basescan.org/tx/0x7a" : null,
    sponsored: true,
    actualWithdrawAmount: outcome === "EXECUTED_VERIFYING_DESTINATION" ? "5000077" : null,
    prePositionAmount: "5000077",
    postPositionAmount: outcome === "EXECUTED_VERIFYING_DESTINATION" ? "0" : null,
    blockNumber: "45384020",
    errorCode: null,
    readyForDestinationVerification: outcome === "EXECUTED_VERIFYING_DESTINATION",
    ...overrides,
  });

  const mockAll = (page: import("@playwright/test").Page, execution: unknown) => {
    return Promise.all([
      page.route("**/api/vindex/positions/current", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(POSITION_MODEL) }),
      ),
      page.route("**/api/vindex/decisions/current", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(DRILL_DECISION) }),
      ),
      page.route("**/api/vindex/executions/prepared", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ preparation: null, execution }) }),
      ),
    ]);
  };

  test("pending execution renders EVACUATING without funds claims", async ({ page }) => {
    await mockAll(page, executionOf("EXECUTION_PENDING"));
    await page.goto("/monitor", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText("EVACUATING");
    await expect(page.locator("body")).toContainText("direct_evac_1");
    const text = await page.locator("body").innerText();
    expect(text).not.toContain("PROTECTED");
  });

  test("confirmed execution renders EXECUTION CONFIRMED — VERIFYING DESTINATION", async ({ page }) => {
    await mockAll(page, executionOf("EXECUTED_VERIFYING_DESTINATION"));
    await page.goto("/monitor", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText("EXECUTION CONFIRMED — VERIFYING DESTINATION");
    await expect(page.locator("body")).toContainText("direct_evac_1");
    await expect(page.locator("body")).toContainText("sepolia.basescan.org");
    await expect(page.locator("body")).toContainText("5.000077 USDC (test)");
    const text = await page.locator("body").innerText();
    expect(text).not.toContain("PROTECTED");
  });

  test("failed execution renders honestly", async ({ page }) => {
    await mockAll(page, executionOf("EXECUTION_FAILED", { errorCode: "RECEIPT_REVERTED" }));
    await page.goto("/monitor", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText("EXECUTION FAILED");
    await expect(page.locator("body")).toContainText("RECEIPT_REVERTED");
    const text = await page.locator("body").innerText();
    expect(text).not.toContain("PROTECTED");
    expect(text).not.toContain("$");
  });
});

test.describe("M8 destination verification + receipt", () => {
  const POSITION_MODEL = {
    position: {
      chainId: 84532,
      networkName: "Base Sepolia",
      protocol: "Aave V3",
      asset: { symbol: "USDC", label: "USDC — Aave Base Sepolia test asset", address: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", decimals: 6 },
      positionToken: { symbol: "aUSDC", address: "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC" },
      executionWallet: "0x675638ddbbf8b70b906d68e3485da72c6c63d130",
      safeWallet: "0xC44685b7c78cC9C9b7f6623d7697Ac30ab0D6Dc9",
      suppliedBalance: { baseUnits: "0", formatted: "0" },
      executionWalletUsdcBalance: { baseUnits: "0", formatted: "0" },
      executionWalletNativeBalance: { wei: "20000000000000000", formatted: "0.02" },
      safeWalletUsdcBalance: { baseUnits: "5000123", formatted: "5.000123" },
      blockNumber: "45384000",
      blockTimestamp: "2026-08-12T12:00:00.000Z",
      observedAt: "2026-08-12T12:00:30.000Z",
    },
    readiness: { networkValid: true, contractsValid: true, executionWalletValid: true, positionExists: false, safeWalletConfigured: true, safeWalletValid: true, keeperHubHealthy: true, readyForMonitoring: false },
    freshness: "live",
    diagnostics: [],
  };

  const executionOf = (outcome: string, overrides: Record<string, unknown> = {}) => ({
    outcome,
    executionId: "e8",
    decisionId: "d2",
    keeperhubExecutionId: "direct_evac_1",
    status: "completed",
    transactionHash: "0x14e84855f63b09831fc7e23ccc31f009acf6f73fb5eb483e745d0954d2777cc5",
    transactionLink: "https://sepolia.basescan.org/tx/0x14e84855f63b09831fc7e23ccc31f009acf6f73fb5eb483e745d0954d2777cc5",
    sponsored: true,
    actualWithdrawAmount: "5000123",
    prePositionAmount: "5000123",
    postPositionAmount: "0",
    blockNumber: "45399100",
    errorCode: null,
    readyForDestinationVerification: outcome === "EXECUTED_VERIFYING_DESTINATION" || outcome === "PROTECTED",
    ...overrides,
  });

  const receiptMeta = {
    id: "715c429a-fbd3-41c6-9aca-5fcc2c6a665e",
    status: "PROTECTED",
    verifiedAmount: "5000123",
    destination: "0xC44685b7c78cC9C9b7f6623d7697Ac30ab0D6Dc9",
  };

  const mockDashboard = (page: import("@playwright/test").Page, execution: unknown, receipt: unknown = receiptMeta) => {
    return Promise.all([
      page.route("**/api/vindex/positions/current", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(POSITION_MODEL) }),
      ),
      page.route("**/api/vindex/decisions/current", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ positionId: "p", state: "CONFIRMING", policy: { mode: "DRILL_HIGH_SENSITIVITY", version: 2 }, matchedFamilies: [], matchedCount: 3, drill: true, drillLabel: "PROTECTION DRILL — HIGH-SENSITIVITY POLICY", drillExplanation: "Real measurements with intentionally sensitive thresholds. This is a protection drill, not evidence of an Aave exploit.", readyForSimulation: true }) }),
      ),
      page.route("**/api/vindex/executions/prepared", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ preparation: null, execution }) }),
      ),
      page.route("**/api/vindex/receipts/current", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ receipt }) }),
      ),
    ]);
  };

  test("VERIFYING DESTINATION state renders without PROTECTED", async ({ page }) => {
    await mockDashboard(page, executionOf("EXECUTED_VERIFYING_DESTINATION"), null);
    await page.goto("/monitor", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText("EXECUTION CONFIRMED — VERIFYING DESTINATION");
    const text = await page.locator("body").innerText();
    expect(text).not.toContain("POSITION PROTECTED");
  });

  test("PROTECTED state appears only with a verified receipt and offers the receipt CTA", async ({ page }) => {
    await mockDashboard(page, executionOf("PROTECTED"), receiptMeta);
    await page.goto("/monitor", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText("POSITION PROTECTED");
    await expect(page.locator("body")).toContainText("The configured safe wallet received the verified result.");
    await expect(page.getByRole("link", { name: "View Rescue Receipt" })).toBeVisible();
    await expect(page.getByRole("link", { name: "View Rescue Receipt" })).toHaveAttribute("href", "/receipt/715c429a-fbd3-41c6-9aca-5fcc2c6a665e");
  });

  test("INTERVENTION REQUIRED never shows PROTECTED", async ({ page }) => {
    await mockDashboard(page, executionOf("INTERVENTION_REQUIRED", { errorCode: "DESTINATION_MISMATCH" }), null);
    await page.goto("/monitor", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText("INTERVENTION REQUIRED");
    await expect(page.locator("body")).toContainText("No further execution was triggered");
    const text = await page.locator("body").innerText();
    expect(text).not.toContain("POSITION PROTECTED");
  });

  const RECEIPT_BODY = {
    id: "715c429a-fbd3-41c6-9aca-5fcc2c6a665e",
    executionId: "e8",
    positionId: "p",
    policyMode: "DRILL_HIGH_SENSITIVITY",
    verifiedAmount: "5000123",
    destination: "0xC44685b7c78cC9C9b7f6623d7697Ac30ab0D6Dc9",
    txHash: "0x14e84855f63b09831fc7e23ccc31f009acf6f73fb5eb483e745d0954d2777cc5",
    keeperhubExecutionId: "direct_evac_1",
    status: "PROTECTED",
    receipt: {
      drillLabel: "PROTECTION DRILL — HIGH-SENSITIVITY POLICY",
      drillExplanation: "Real measurements with intentionally sensitive thresholds. This is a protection drill, not evidence of an Aave exploit.",
      network: "Base Sepolia",
      protocol: "Aave V3",
      position: "USDC — Aave Base Sepolia test asset",
      policy: { label: "Protection Drill / High Sensitivity", mode: "DRILL_HIGH_SENSITIVITY", version: 2, requiredSignals: 2 },
      consensus: { rule: "2-of-3 distinct live families inside the correlation window", matchedCount: 3 },
      action: "Aave V3 withdraw(asset, type(uint256).max, safeWallet) — no swap",
      expectedWithdraw: "5000123",
      withdrawn: "5000123",
      verifiedReceived: "5000123",
      destination: { full: "0xC44685b7c78cC9C9b7f6623d7697Ac30ab0D6Dc9", short: "0xC446…6Dc9" },
      keeperhub: { executionId: "direct_evac_1", sponsored: true },
      transaction: { hash: "0x14e84855f63b09831fc7e23ccc31f009acf6f73fb5eb483e745d0954d2777cc5", link: "https://sepolia.basescan.org/tx/0x14e84855f63b09831fc7e23ccc31f009acf6f73fb5eb483e745d0954d2777cc5", block: "45399100" },
      balances: { pre: "0", post: "5000123", delta: "5000123" },
      verification: { status: "Passed", blockNumber: "45400166", blockTimestamp: "2026-08-12T21:03:40.000Z" },
      status: "PROTECTED",
      generatedAt: "2026-08-12T21:03:41.000Z",
    },
    createdAt: "2026-08-12T21:03:41.000Z",
  };

  test("the Rescue Receipt page renders real evidence fields", async ({ page }) => {
    await page.route("**/api/vindex/receipts/*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RECEIPT_BODY) }),
    );
    await page.goto("/receipt/715c429a-fbd3-41c6-9aca-5fcc2c6a665e", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText("VINDEX RESCUE / 715c429a");
    await expect(page.locator("body")).toContainText("PROTECTION DRILL — HIGH-SENSITIVITY POLICY");
    await expect(page.locator("body")).toContainText("not evidence of an Aave exploit");
    await expect(page.locator("body")).toContainText("Protection Drill / High Sensitivity");
    await expect(page.locator("body")).toContainText("5.000123 USDC (test)");
    await expect(page.locator("body")).toContainText("0x14e84855f63b09831fc7e23ccc31f009acf6f73fb5eb483e745d0954d2777cc5");
    await expect(page.locator("body")).toContainText("View on BaseScan Sepolia");
    await expect(page.locator("body")).toContainText("PROTECTED");
    const text = await page.locator("body").innerText();
    expect(text).not.toContain("swap executed");
    expect(text).not.toContain("Aave is being hacked");
  });
});
});
