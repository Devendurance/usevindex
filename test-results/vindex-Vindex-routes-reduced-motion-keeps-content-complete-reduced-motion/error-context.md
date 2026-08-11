# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: vindex.spec.ts >> Vindex routes >> reduced motion keeps content complete
- Location: tests\e2e\vindex.spec.ts:219:7

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3000/
Call log:
  - navigating to "http://127.0.0.1:3000/", waiting until "load"

```

# Test source

```ts
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
  166 |     await expect(menuButton).toBeFocused();
  167 |   });
  168 | 
  169 |   test("preview routes never render fabricated evidence or browser persistence", async ({ page }) => {
  170 |     const storageWrites: string[] = [];
  171 |     await page.addInitScript(() => {
  172 |       const original = Storage.prototype.setItem;
  173 |       Storage.prototype.setItem = function (key, value) {
  174 |         window.dispatchEvent(new CustomEvent("vindex-storage-write", { detail: { key, value } }));
  175 |         return original.call(this, key, value);
  176 |       };
  177 |     });
  178 |     await page.exposeFunction("recordStorageWrite", (payload: { key: string }) => storageWrites.push(payload.key));
  179 |     await page.addInitScript(() => {
  180 |       window.addEventListener("vindex-storage-write", (event) => {
  181 |         const recorder = (window as unknown as { recordStorageWrite?: (payload: unknown) => void }).recordStorageWrite;
  182 |         recorder?.((event as CustomEvent).detail);
  183 |       });
  184 |     });
  185 |     for (const route of routes.slice(6)) {
  186 |       await page.goto(route, { waitUntil: "domcontentloaded", timeout: 60_000 });
  187 |       const text = await page.locator("body").innerText();
  188 |       expect(text).not.toMatch(/0x[a-fA-F0-9]{8,}/);
  189 |       expect(text).not.toMatch(/\$\s?\d/);
  190 |       expect(text).not.toMatch(/\b(?:19|20)\d{2}-\d{2}-\d{2}\b/);
  191 |       expect(text).not.toContain("VINDEX RESCUE / 00041");
  192 |       expect(text).toContain("—");
  193 |     }
  194 |     expect(storageWrites).toEqual([]);
  195 |   });
  196 | 
  197 |   test("controlled preview states render without live evidence", async ({ page }) => {
  198 |     const stateRoutes = [
  199 |       ["/monitor?state=elevated", "Signals are elevated"],
  200 |       ["/monitor?state=degraded", "MONITORING DEGRADED"],
  201 |       ["/confirm?state=confirming", "Confirmation in progress"],
  202 |       ["/simulation/preview?state=simulating", "SIMULATING"],
  203 |       ["/evacuation/preview?state=executing", "EXECUTING"],
  204 |       ["/outcome/preview?state=blocked", "BLOCKED"],
  205 |       ["/outcome/preview?state=failed", "FAILED"],
  206 |       ["/outcome/preview?state=execution_unknown", "EXECUTION_UNKNOWN"],
  207 |       ["/outcome/preview?state=intervention_required", "INTERVENTION_REQUIRED"],
  208 |     ] as const;
  209 | 
  210 |     for (const [route, expected] of stateRoutes) {
  211 |       await page.goto(route, { waitUntil: "domcontentloaded", timeout: 60_000 });
  212 |       await expect(page.locator("body")).toContainText(expected);
  213 |       await expect(page.locator("body")).toContainText("—");
  214 |       const bodyText = await page.locator("body").innerText();
  215 |       expect(bodyText).not.toMatch(/0x[a-fA-F0-9]{8,}/);
  216 |     }
  217 |   });
  218 | 
  219 |   test("reduced motion keeps content complete", async ({ page }) => {
  220 |     await page.emulateMedia({ reducedMotion: "reduce" });
> 221 |     await page.goto("/");
      |                ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3000/
  222 |     await expect(page.locator(".protected-route").first()).toBeVisible();
  223 |     expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto");
  224 |   });
  225 | 
  226 |   test("desktop surfaces have no serious accessibility violations", async ({ page }) => {
  227 |     await page.goto("/monitor");
  228 |     const results = await new AxeBuilder({ page }).analyze();
  229 |     const serious = results.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious");
  230 |     expect(serious).toEqual([]);
  231 |   });
  232 | });
  233 | 
```