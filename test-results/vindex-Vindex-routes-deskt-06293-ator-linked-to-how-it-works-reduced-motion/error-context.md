# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: vindex.spec.ts >> Vindex routes >> desktop hero includes a down indicator linked to how it works
- Location: tests\e2e\vindex.spec.ts:63:7

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3000/
Call log:
  - navigating to "http://127.0.0.1:3000/", waiting until "load"

```

# Test source

```ts
  1   | import { expect, test } from "@playwright/test";
  2   | import AxeBuilder from "@axe-core/playwright";
  3   | 
  4   | const routes = [
  5   |   "/",
  6   |   "/setup",
  7   |   "/settings",
  8   |   "/monitor",
  9   |   "/confirm",
  10  |   "/demo",
  11  |   "/simulation/preview",
  12  |   "/evacuation/preview",
  13  |   "/receipt/preview",
  14  |   "/audit/preview",
  15  |   "/outcome/preview",
  16  | ];
  17  | 
  18  | test.describe("Vindex routes", () => {
  19  |   test.beforeEach(async ({ page }) => {
  20  |     await page.route("**/api/**", (route) => route.abort());
  21  |   });
  22  | 
  23  |   test("all planned routes render a meaningful page", async ({ page }) => {
  24  |     for (const route of routes) {
  25  |       await page.goto(route, { waitUntil: "domcontentloaded", timeout: 60_000 });
  26  |       await expect(page.locator('[data-page-ready="true"]')).toBeVisible();
  27  |       await expect(page.locator("main h1")).toHaveCount(1);
  28  |       await expect(page.locator("body")).not.toContainText("Application error");
  29  |       expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
  30  |     }
  31  |   });
  32  | 
  33  |   test("hero preserves the approved quiet hierarchy", async ({ page }) => {
  34  |     await page.goto("/");
  35  |     const hero = page.locator(".marketing-hero");
  36  |     await expect(hero).toContainText("DETECT THE THREAT.");
  37  |     await expect(hero).toContainText("EXECUTE THE ESCAPE.");
  38  |     await expect(hero.getByText("Vindex watches supported DeFi positions, confirms converging danger and routes a verified exit through KeeperHub.")).toBeVisible();
  39  |     await expect(hero.getByRole("link", { name: "RUN A DRY RUN" })).toHaveAttribute("href", "/setup");
  40  |     await expect(hero.locator(".primary-cta")).toHaveCount(1);
  41  |     await expect(hero.locator(".protected-route")).toHaveCount(1);
  42  |     await expect(hero.locator(".proof-point")).toHaveCount(3);
  43  |     await expect(hero).not.toContainText("SIMULATION ONLY");
  44  |     await expect(hero).not.toContainText("Rescue Receipt");
  45  |   });
  46  | 
  47  |   test("hero follows the approved route-first DOM order", async ({ page }) => {
  48  |     await page.goto("/");
  49  |     const order = await page.locator(".marketing-hero__inner").evaluate((hero) =>
  50  |       Array.from(hero.children).map((child) => {
  51  |         if (child.matches("h1")) return "headline";
  52  |         if (child.matches(".marketing-hero__route")) return "route";
  53  |         if (child.matches(".marketing-hero__copy")) return "supporting-copy";
  54  |         if (child.matches(".primary-cta")) return "primary-cta";
  55  |         if (child.matches(".proof-row")) return "proof-row";
  56  |         return "other";
  57  |       }),
  58  |     );
  59  | 
  60  |     expect(order).toEqual(["headline", "route", "supporting-copy", "primary-cta", "proof-row"]);
  61  |   });
  62  | 
  63  |   test("desktop hero includes a down indicator linked to how it works", async ({ page }) => {
  64  |     test.skip((page.viewportSize()?.width ?? 0) <= 900, "desktop-only hero affordance");
> 65  |     await page.goto("/");
      |                ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3000/
  66  | 
  67  |     const indicator = page.locator('.marketing-hero a.down-indicator[href="#how-it-works"]');
  68  |     await expect(indicator).toBeVisible();
  69  |   });
  70  | 
  71  |   test("proof row uses three black square arrow tiles", async ({ page }) => {
  72  |     await page.goto("/");
  73  | 
  74  |     const proofPoints = page.locator(".proof-row > .proof-point");
  75  |     const arrowTiles = proofPoints.locator(".arrow-tile");
  76  |     await expect(proofPoints).toHaveCount(3);
  77  |     await expect(arrowTiles).toHaveCount(3);
  78  |     for (let index = 0; index < 3; index += 1) {
  79  |       await expect(proofPoints.nth(index).locator(".arrow-tile")).toHaveCount(1);
  80  |     }
  81  | 
  82  |     const tileStyles = await arrowTiles.evaluateAll((tiles) =>
  83  |       tiles.map((tile) => {
  84  |         const style = getComputedStyle(tile);
  85  |         return {
  86  |           backgroundColor: style.backgroundColor,
  87  |           height: Number.parseFloat(style.height),
  88  |           width: Number.parseFloat(style.width),
  89  |         };
  90  |       }),
  91  |     );
  92  | 
  93  |     for (const style of tileStyles) {
  94  |       expect(style.backgroundColor).toBe("rgb(17, 17, 17)");
  95  |       expect(style.width).toBe(style.height);
  96  |     }
  97  |   });
  98  | 
  99  |   test("primary and secondary buttons keep square corners", async ({ page }) => {
  100 |     test.skip((page.viewportSize()?.width ?? 0) <= 900, "desktop navigation button is hidden on mobile");
  101 |     await page.goto("/");
  102 | 
  103 |     const primaryRadius = await page.locator(".marketing-hero .primary-cta").evaluate((button) =>
  104 |       Number.parseFloat(getComputedStyle(button).borderTopLeftRadius),
  105 |     );
  106 |     const secondaryRadius = await page.locator(".site-nav__demo.secondary-button").evaluate((button) =>
  107 |       Number.parseFloat(getComputedStyle(button).borderTopLeftRadius),
  108 |     );
  109 | 
  110 |     expect.soft(primaryRadius, "primary button radius").toBeLessThanOrEqual(1);
  111 |     expect.soft(secondaryRadius, "secondary button radius").toBeLessThanOrEqual(1);
  112 |   });
  113 | 
  114 |   test("View demo uses the layered secondary treatment", async ({ page }) => {
  115 |     test.skip((page.viewportSize()?.width ?? 0) <= 900, "desktop navigation button is hidden on mobile");
  116 |     await page.goto("/");
  117 | 
  118 |     await expect(page.locator(".site-nav__demo")).toHaveClass(/\bsecondary-button--layered\b/);
  119 |   });
  120 | 
  121 |   test("desktop navigation marks View demo as the current page", async ({ page }) => {
  122 |     test.skip((page.viewportSize()?.width ?? 0) <= 900, "desktop navigation is hidden on mobile");
  123 |     await page.goto("/demo");
  124 | 
  125 |     await expect(page.locator(".site-nav__demo")).toHaveAttribute("aria-current", "page");
  126 |   });
  127 | 
  128 |   test("setup validates locally and never submits unavailable actions", async ({ page }) => {
  129 |     await page.goto("/setup");
  130 |     const wallet = page.getByLabel("Safe wallet");
  131 |     await wallet.fill("0x-invalid");
  132 |     await wallet.blur();
  133 |     await expect(wallet).toHaveAttribute("aria-invalid", "true");
  134 |     await expect(page.getByRole("button", { name: "Save configuration" })).toBeDisabled();
  135 |     await expect(page.getByRole("button", { name: "Arm position" })).toBeDisabled();
  136 |     await expect(page.locator("body")).toContainText("live validation");
  137 |   });
  138 | 
  139 |   test("mobile navigation is keyboard reachable and responds locally", async ({ page }) => {
  140 |     test.skip((await page.evaluate(() => window.innerWidth)) > 900, "mobile menu is collapsed only on small viewports");
  141 |     await page.goto("/");
  142 |     const menu = page.getByRole("button", { name: "Open navigation" });
  143 |     await menu.focus();
  144 |     await expect(menu).toBeFocused();
  145 |     await menu.press("Enter");
  146 |     await expect(page.getByRole("button", { name: "Close navigation" })).toBeVisible();
  147 |     await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toContainText("View demo");
  148 |     await page.getByRole("link", { name: "View demo" }).last().click();
  149 |     await expect(page).toHaveURL(/\/demo$/);
  150 |   });
  151 | 
  152 |   test("mobile navigation closes on Escape and returns focus to its menu button", async ({ page }) => {
  153 |     test.skip((page.viewportSize()?.width ?? 0) > 900, "mobile menu is collapsed only on small viewports");
  154 |     await page.goto("/");
  155 | 
  156 |     const menuButton = page.getByRole("button", { name: "Open navigation" });
  157 |     await menuButton.click();
  158 |     const mobileNavigation = page.getByRole("navigation", { name: "Mobile navigation" });
  159 |     const firstLink = mobileNavigation.getByRole("link").first();
  160 |     await firstLink.focus();
  161 |     await expect(firstLink).toBeFocused();
  162 | 
  163 |     await page.keyboard.press("Escape");
  164 | 
  165 |     await expect(menuButton).toHaveAttribute("aria-expanded", "false");
```