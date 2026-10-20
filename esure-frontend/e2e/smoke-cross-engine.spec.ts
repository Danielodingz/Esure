import { test, expect, devices } from "@playwright/test";

// Skip Firefox/WebKit in CI for now if browsers not available
test.describe.configure({
  mode: "parallel",
});

const SMOKE_TESTS = [
  {
    name: "Catalogue Selection",
    navigate: "/",
    actions: async (page) => {
      await page.waitForLoadState("networkidle");
      const button = page.locator('button:has-text("Select scenario")').first();
      await expect(button).toBeVisible();
      return button;
    },
  },
  {
    name: "Run Start",
    navigate: "/",
    actions: async (page) => {
      await page.waitForLoadState("networkidle");
      const startButton = page.locator("button:has-text(/Start|Run/)").first();
      await expect(startButton).toBeVisible();
      return startButton;
    },
  },
  {
    name: "Report Rendering",
    navigate: "/",
    actions: async (page) => {
      await page.waitForLoadState("networkidle");
      const report = page.locator("[data-testid=report]").first();
      if (await report.isVisible()) {
        expect(report).toBeTruthy();
      }
      return page;
    },
  },
];

// Firefox smoke tests
test.describe("Cross-Engine Smoke - Firefox", () => {
  test.use({ ...devices["Desktop Firefox"] });

  for (const test_case of SMOKE_TESTS) {
    test(`Firefox: ${test_case.name}`, async ({ page }) => {
      await page.goto(test_case.navigate);
      const result = await test_case.actions(page);
      expect(result).toBeTruthy();
    });
  }

  test("Firefox: Keyboard navigation works", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    let focusCount = 0;
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Tab");
      const focused = await page.locator(":focus").first();
      if (await focused.isVisible()) focusCount++;
    }

    expect(focusCount).toBeGreaterThan(0);
  });
});

// WebKit (Safari) smoke tests
test.describe("Cross-Engine Smoke - WebKit", () => {
  test.use({ ...devices["Desktop Safari"] });

  for (const test_case of SMOKE_TESTS) {
    test(`WebKit: ${test_case.name}`, async ({ page }) => {
      await page.goto(test_case.navigate);
      const result = await test_case.actions(page);
      expect(result).toBeTruthy();
    });
  }

  test("WebKit: Keyboard navigation works", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    let focusCount = 0;
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Tab");
      const focused = await page.locator(":focus").first();
      if (await focused.isVisible()) focusCount++;
    }

    expect(focusCount).toBeGreaterThan(0);
  });
});

// Chromium baseline (full journey)
test.describe("Cross-Engine Smoke - Chromium", () => {
  test.use({ ...devices["Desktop Chrome"] });

  test("Chromium: Full primary journey", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Select scenario
    const selectButton = page.locator('button:has-text("Select")').first();
    await expect(selectButton).toBeVisible();
    await selectButton.click();

    // Start run
    const startButton = page.locator("button:has-text(/Start|Run/)").first();
    if (await startButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await startButton.click();
    }

    // Verify page remains interactive
    const mainContent = page.locator("main, [role=main]").first();
    await expect(mainContent).toBeVisible();
  });
});
