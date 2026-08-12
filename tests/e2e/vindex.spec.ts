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
    const headline = hero.getByRole("heading", { level: 1 });
    await expect(headline).toContainText("Detect the threat.");
    await expect(headline).toContainText("Execute the escape.");
    await expect(headline).toHaveJSProperty("innerHTML", "Detect the threat.<br>Execute the escape.");
    await expect(hero.getByText("Vindex watches supported DeFi positions, confirms converging danger and routes a verified exit through KeeperHub.")).toBeVisible();
    await expect(hero.getByRole("link", { name: "RUN A DRY RUN" })).toHaveAttribute("href", "/setup");
    await expect(hero.locator(".primary-cta")).toHaveCount(1);
    await expect(hero.locator(".marketing-hero__route")).toHaveCount(0);
    await expect(hero.locator(".protected-route")).toHaveCount(0);
    await expect(hero.locator(".proof-point")).toHaveCount(3);
    await expect(hero).not.toContainText("SIMULATION ONLY");
    await expect(hero).not.toContainText("Rescue Receipt");
  });

  test("hero follows the approved compact DOM order", async ({ page }) => {
    await page.goto("/");
    const order = await page.locator(".marketing-hero__inner").evaluate((hero) =>
      Array.from(hero.children).map((child) => {
        if (child.matches("h1")) return "headline";
        if (child.matches(".marketing-hero__copy")) return "supporting-copy";
        if (child.matches(".primary-cta")) return "primary-cta";
        if (child.matches(".proof-row")) return "proof-row";
        return "other";
      }),
    );

    expect(order).toEqual(["headline", "supporting-copy", "primary-cta", "proof-row"]);
  });

  test("desktop and tablet hero headline stays on two visual lines and fits the first viewport", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "desktop/tablet layout acceptance runs once in the desktop project");

    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 1280, height: 800 },
      { width: 1024, height: 800 },
      { width: 768, height: 900 },
      { width: 700, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/");

      const visualLineCount = await page.locator(".marketing-hero h1").evaluate((headline) => {
        const lineTops = new Set<number>();
        const walker = document.createTreeWalker(headline, NodeFilter.SHOW_TEXT);
        let textNode = walker.nextNode();

        while (textNode) {
          const range = document.createRange();
          range.selectNodeContents(textNode);
          for (const rect of range.getClientRects()) {
            if (rect.width > 0 && rect.height > 0) lineTops.add(Math.round(rect.top));
          }
          textNode = walker.nextNode();
        }

        return lineTops.size;
      });
      const proofBottom = await page.locator(".marketing-hero .proof-row").evaluate((proofRow) => proofRow.getBoundingClientRect().bottom);

      expect.soft(visualLineCount, `${viewport.width}px headline line count`).toBe(2);
      expect.soft(proofBottom, `${viewport.width}px proof row bottom`).toBeLessThanOrEqual(viewport.height);
      expect.soft(await page.evaluate(() => document.documentElement.scrollWidth), `${viewport.width}px horizontal overflow`).toBeLessThanOrEqual(viewport.width);
    }
  });

  test("Vindex brand always returns to the landing page", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Vindex home" })).toHaveAttribute("href", "/");

    await page.goto("/monitor");
    const productBrand = page.getByRole("link", { name: "Vindex home" });
    await expect(productBrand).toHaveAttribute("href", "/");
    await productBrand.click();
    await expect(page).toHaveURL(/\/$/);
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
    await menuButton.focus();
    await menuButton.press("Enter");
    await expect(page.getByRole("button", { name: "Close navigation" })).toBeVisible();
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
      expect(text).toContain("—");
    }
    expect(storageWrites).toEqual([]);
  });

  test("controlled preview states render without live evidence", async ({ page }) => {
    const stateRoutes = [
      ["/monitor?state=elevated", "Signals are elevated"],
      ["/monitor?state=degraded", "MONITORING DEGRADED"],
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
