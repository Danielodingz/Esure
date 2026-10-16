import { expect, test } from "@playwright/test";
import type { RunReport, ScenarioSummary } from "../src/lib/api";

const mockScenarios: ScenarioSummary[] = [
  {
    id: "xlm-payment",
    version: 1,
    name: "Native XLM Payment",
    description: "Transfers native XLM between isolated Testnet accounts.",
    contentHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  },
  {
    id: "issued-asset-payment",
    version: 1,
    name: "Issued Asset Payment",
    description: "Tests trustline creation and token distribution.",
    contentHash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  },
];

const runningRun: RunReport = {
  id: "run-e2e-123",
  scenarioId: "issued-asset-payment",
  scenarioVersion: 1,
  scenarioSchemaVersion: 1,
  scenarioContentHash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  network: "testnet",
  status: "running",
  createdAt: "2026-09-08T11:00:00.000Z",
  steps: [
    {
      id: "fund-accounts",
      type: "fundAccounts",
      status: "passed",
      message: "Test accounts funded.",
    },
  ],
  assertions: [],
  summary: {
    stepsPassed: 1,
    stepsFailed: 0,
    assertionsPassed: 0,
    assertionsFailed: 0,
  },
};

const passedRun: RunReport = {
  ...runningRun,
  status: "passed",
  completedAt: "2026-09-08T11:00:05.000Z",
  steps: [
    {
      id: "fund-accounts",
      type: "fundAccounts",
      status: "passed",
      message: "Test accounts funded.",
    },
    {
      id: "trust",
      type: "changeTrust",
      status: "passed",
      transactionHash: "a1b2c3d4e5f678901234567890abcdef1234567890abcdef1234567890abcdef",
      ledger: 123456,
      message: "Transaction confirmed on Stellar Testnet.",
    },
    {
      id: "pay-demo",
      type: "payment",
      status: "passed",
      transactionHash: "f6e5d4c3b2a178901234567890abcdef1234567890abcdef1234567890abcdef",
      ledger: 123457,
      message: "Transaction confirmed on Stellar Testnet.",
    },
  ],
  assertions: [
    {
      type: "balanceEquals",
      status: "passed",
      expected: "100",
      actual: "100",
      message: "Balance for recipient/DEMO matched.",
    },
    {
      type: "stepSucceeded",
      status: "passed",
      expected: true,
      actual: true,
      message: "Step pay-demo succeeded.",
    },
  ],
  summary: {
    stepsPassed: 3,
    stepsFailed: 0,
    assertionsPassed: 2,
    assertionsFailed: 0,
  },
};

const failedRun: RunReport = {
  ...runningRun,
  status: "failed",
  completedAt: "2026-09-08T11:00:04.000Z",
  steps: [
    {
      id: "fund-accounts",
      type: "fundAccounts",
      status: "passed",
      message: "Test accounts funded.",
    },
    {
      id: "pay-demo",
      type: "payment",
      status: "failed",
      transactionHash: "f6e5d4c3b2a178901234567890abcdef1234567890abcdef1234567890abcdef",
      stellarTransactionCode: "tx_failed",
      stellarOperationCodes: ["op_no_trust"],
      message: "Stellar rejected step pay-demo with tx_failed/op_no_trust.",
    },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `review-step-${String(index + 1).padStart(2, "0")}`,
      type: "payment",
      status: index % 3 === 0 ? "failed" as const : "passed" as const,
      message: `Long report review detail for step ${index + 1}: the operation result and its bounded Testnet evidence are included here to exercise print wrapping and pagination.`,
    })),
  ],
  assertions: [
    {
      type: "balanceEquals",
      status: "passed",
      expected: "100",
      actual: "100",
      message: "Passing balance assertion.",
    },
    {
      type: "paymentDelivered",
      status: "failed",
      expected: true,
      actual: false,
      message: "Failed payment assertion.",
    },
  ],
  summary: {
    stepsPassed: 9,
    stepsFailed: 5,
    assertionsPassed: 1,
    assertionsFailed: 1,
  },
  error: {
    code: "STELLAR_TRANSACTION_FAILED",
    message: "Stellar rejected step pay-demo with tx_failed/op_no_trust. " +
      "Additional review context: the report must preserve this detailed failure text within page bounds. ".repeat(18),
    category: "stellar",
    retryable: false,
    failedStepId: "pay-demo",
    stellarTransactionCode: "tx_failed",
    stellarOperationCodes: ["op_no_trust"],
  },
};

test.describe("Primary User Journey", () => {
  test("selects a scenario, starts a run, polls for completion, and verifies a passed report", async ({ page }) => {
    // 1. Mock scenarios list at the browser boundary
    await page.route("**/api/backend/api/v1/scenarios", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: mockScenarios }),
      });
    });

    let pollCount = 0;
    // 2. Mock start run (POST) and subsequent get run polls (GET)
    await page.route("**/api/backend/api/v1/runs", async (route) => {
      if (route.request().method() === "POST") {
        const postData = route.request().postDataJSON();
        expect(postData).toEqual({ scenarioId: "issued-asset-payment", inputs: {} });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(runningRun),
        });
      } else {
        await route.continue();
      }
    });

    await page.route("**/api/backend/api/v1/runs/run-e2e-123", async (route) => {
      pollCount += 1;
      // First poll returns running state, subsequent poll returns terminal passed report
      const body = pollCount === 1 ? runningRun : passedRun;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });

    // 3. Navigate to application
    await page.goto("/");

    // Verify initial scenario list and count
    await expect(page.locator(".scenario-count")).toHaveText("02 AVAILABLE");
    const issuedCard = page.locator(".scenario-card", { hasText: "Issued Asset Payment" });
    await expect(issuedCard).toBeVisible();

    // 4. Select a scenario
    await issuedCard.click();
    await expect(issuedCard).toHaveClass(/selected/);
    await expect(page.locator(".launch-panel strong")).toHaveText("Issued Asset Payment");
    await expect(page.locator(".launch-panel")).toContainText("issued-asset-payment");

    // Verify empty report state before run
    await expect(page.locator(".empty-report")).toContainText("No run yet");

    // 5. Start the run
    const runButton = page.locator(".launch-panel .run-button");
    await expect(runButton).toBeEnabled();
    await runButton.click();

    // Verify in-progress running state
    await expect(page.locator(".status-badge")).toContainText("Running");
    await expect(page.locator(".report-meta")).toContainText("run-e2e-123");
    await expect(page.locator(".report-meta")).toContainText("testnet");
    await expect(page.locator(".report-meta")).toContainText("CREATED");
    await expect(page.locator(".report-meta")).not.toContainText("COMPLETED");
    await expect(page.locator(".report-meta")).not.toContainText("DURATION");

    // 6. Wait for polling to deliver the terminal passed report
    await expect(page.locator(".status-badge")).toContainText("Passed", { timeout: 10_000 });

    // Verify completed report timestamps and duration
    await expect(page.locator(".report-meta")).toContainText("CREATED");
    await expect(page.locator(".report-meta")).toContainText("COMPLETED");
    await expect(page.locator(".report-meta")).toContainText("DURATION");
    await expect(page.locator(".report-meta")).toContainText("5s");

    // Verify completed steps
    await expect(page.locator(".ledger", { hasText: "L#123456" })).toBeVisible();
    await expect(page.locator(".ledger", { hasText: "L#123457" })).toBeVisible();

    // Verify assertions
    await expect(page.locator(".assertion", { hasText: "Balance for recipient/DEMO matched." })).toBeVisible();
    await expect(page.locator(".assertion", { hasText: "Step pay-demo succeeded." })).toBeVisible();

    // Verify summary score card
    await expect(page.locator(".score strong")).toHaveText("5");
    await expect(page.locator(".score span")).toHaveText("checks passed");
    await expect(page.locator(".summary-card dl")).toContainText("Steps passed3");
    await expect(page.locator(".summary-card dl")).toContainText("Steps failed0");
    await expect(page.locator(".summary-card dl")).toContainText("Assertions passed2");
    await expect(page.locator(".summary-card dl")).toContainText("Assertions failed0");

    // Verify report download link
    const downloadLink = page.locator("a.download");
    await expect(downloadLink).toBeVisible();
    await expect(downloadLink).toHaveAttribute("href", "/api/backend/api/v1/runs/run-e2e-123/report");
    await expect(downloadLink).toHaveAttribute("download", "");

    // Verify run button re-enabled after completion
    await expect(runButton).toHaveText(/Run on Testnet/);
    await expect(runButton).toBeEnabled();
  });
});

test.describe("Loading States", () => {
  test("displays skeleton placeholders while scenarios list is loading", async ({ page }) => {
    let fulfillScenarios: () => void = () => {};
    const scenariosPromise = new Promise<void>((resolve) => {
      fulfillScenarios = resolve;
    });

    await page.route("**/api/backend/api/v1/scenarios", async (route) => {
      await scenariosPromise;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: mockScenarios }),
      });
    });

    await page.goto("/");

    // Verify skeletons and aria-busy while loading
    const grid = page.locator(".scenario-grid");
    await expect(grid).toHaveAttribute("aria-busy", "true");
    await expect(page.locator(".scenario-card.skeleton")).toHaveCount(3);

    // Resolve scenario request
    fulfillScenarios();

    // Verify skeletons disappear and actual scenarios render
    await expect(grid).toHaveAttribute("aria-busy", "false");
    await expect(page.locator(".scenario-card.skeleton")).toHaveCount(0);
    await expect(page.locator(".scenario-card")).toHaveCount(2);
  });

  test("displays progress indicator and disables button while run is in flight", async ({ page }) => {
    await page.route("**/api/backend/api/v1/scenarios", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: mockScenarios }),
      });
    });

    await page.route("**/api/backend/api/v1/runs", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(runningRun),
      });
    });

    // Keep run in "running" state during polls
    await page.route("**/api/backend/api/v1/runs/run-e2e-123", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(runningRun),
      });
    });

    await page.goto("/");
    const runButton = page.locator(".launch-panel .run-button");
    await runButton.click();

    // Verify in-flight loading indicators
    await expect(runButton).toBeDisabled();
    await expect(runButton).toContainText("Running…");
    await expect(page.locator(".running-row")).toBeVisible();
    await expect(page.locator(".running-row .spinner")).toBeVisible();
    await expect(page.locator(".running-row")).toContainText("Esure is executing this flow on Stellar Testnet.");

    // Verify in-progress report shows created timestamp but not completion info
    await expect(page.locator(".report-meta")).toContainText("CREATED");
    await expect(page.locator(".report-meta")).not.toContainText("COMPLETED");
    await expect(page.locator(".report-meta")).not.toContainText("DURATION");
  });
});

test.describe("Failed Run and Error States", () => {
  test("displays failed execution details when a run fails", async ({ page }) => {
    await page.route("**/api/backend/api/v1/scenarios", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: mockScenarios }),
      });
    });

    await page.route("**/api/backend/api/v1/runs", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(runningRun),
      });
    });

    // Poll returns failed report
    await page.route("**/api/backend/api/v1/runs/run-e2e-123", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(failedRun),
      });
    });

    await page.goto("/");
    await page.locator(".launch-panel .run-button").click();

    // Verify failed badge
    await expect(page.locator(".status-badge")).toContainText("Failed", { timeout: 10_000 });

    // Verify error banner inside report
    const runError = page.locator(".run-error");
    await expect(runError).toBeVisible();
    await expect(runError).toContainText("STELLAR_TRANSACTION_FAILED");
    await expect(runError).toContainText("Stellar rejected step pay-demo with tx_failed/op_no_trust.");

    // Verify summary counts reflection
    await expect(page.locator(".summary-card dl")).toContainText("Steps failed5");

    const reportFilters = page.getByRole("group", { name: "Report filter" });
    await expect(reportFilters.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    await reportFilters.getByRole("button", { name: "Failed" }).click();
    await expect(reportFilters.getByRole("button", { name: "Failed" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".timeline-row", { hasText: "Test accounts funded." })).toHaveCount(0);
    await expect(page.locator(".timeline-row", { hasText: "Stellar rejected step pay-demo" })).toBeVisible();
    await expect(page.locator(".assertion", { hasText: "Passing balance assertion." })).toHaveCount(0);
    await expect(page.locator(".assertion", { hasText: "Failed payment assertion." })).toBeVisible();
    await expect(runError).toBeVisible();
    await expect(page.locator(".summary-card dl")).toContainText("Steps failed5");

    await reportFilters.getByRole("button", { name: "All" }).click();
    await expect(page.locator(".timeline-row", { hasText: "Test accounts funded." })).toBeVisible();
    await expect(page.locator(".assertion", { hasText: "Passing balance assertion." })).toBeVisible();

    await page.emulateMedia({ media: "print" });
    await expect(page.locator(".print-report-header")).toBeVisible();
    await expect(page.locator(".print-report-header")).toContainText("Issued Asset Payment");
    await expect(page.locator(".print-report-header")).toContainText("sha256:2222222222222222222222222222222222222222222222222222222222222222");
    await expect(page.locator(".transaction-hash")).toContainText("f6e5d4c3b2a178901234567890abcdef1234567890abcdef1234567890abcdef");
    await expect(page.locator(".print-status-label").filter({ hasText: "Failed" })).toBeVisible();
    await expect(page.locator(".launch-panel")).toBeHidden();
    await expect(page.locator(".scenario-grid")).toBeHidden();
    await expect(reportFilters).toBeHidden();
    const pdf = await page.pdf({ printBackground: true });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");

    // Download link is still provided for failed runs for inspection
    await page.emulateMedia({ media: "screen" });
    await expect(page.locator("a.download")).toBeVisible();
  });

  test("displays error banner when starting a run fails", async ({ page }) => {
    await page.route("**/api/backend/api/v1/scenarios", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: mockScenarios }),
      });
    });

    // Mock run creation rejection (HTTP 429 Rate Limited)
    await page.route("**/api/backend/api/v1/runs", async (route) => {
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "RATE_LIMITED",
            message: "Request limit exceeded. Try again later.",
          },
        }),
      });
    });

    await page.goto("/");
    await page.locator(".launch-panel .run-button").click();

    // Verify top-level error alert
    const errorBanner = page.locator(".error-banner[role='alert']");
    await expect(errorBanner).toBeVisible();
    await expect(errorBanner).toContainText("Couldn't complete the request");
    await expect(errorBanner).toContainText("Request limit exceeded. Try again later. (RATE_LIMITED)");

    // Empty report remains
    await expect(page.locator(".empty-report")).toBeVisible();
  });

  test("displays error banner when loading scenarios fails", async ({ page }) => {
    // Mock scenarios load failure (HTTP 503 Backend Unavailable)
    await page.route("**/api/backend/api/v1/scenarios", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "BACKEND_UNAVAILABLE",
            message: "Esure Backend is unavailable. Start it and try again.",
          },
        }),
      });
    });

    await page.goto("/");

    // Verify error banner
    const errorBanner = page.locator(".empty-scenarios[role='alert']");
    await expect(errorBanner).toBeVisible();
    await expect(errorBanner).toContainText("Couldn't load scenarios");
    await expect(errorBanner).toContainText("Esure Backend is unavailable. Start it and try again. (BACKEND_UNAVAILABLE)");

    // Verify run button is disabled since no scenario could be selected
    await expect(page.locator(".launch-panel .run-button")).toBeDisabled();
  });
});
