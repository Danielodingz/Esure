import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act, within } from "@testing-library/react";
import { Dashboard, filterScenario } from "./dashboard";
import * as api from "@/lib/api";
import { type RunReport } from "@/lib/api";

// --- URL Restoration Mocks ---
const mockPush = vi.fn();
const mockReplace = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  usePathname: () => "/dashboard",
  useSearchParams: () => mockSearchParams,
}));
// -----------------------------

const mockScenarios: api.ScenarioSummary[] = [
  {
    id: "xlm-payment",
    version: 1,
    name: "XLM payment",
    description: "Fund two Testnet accounts, send XLM, and verify the recipient balance.",
    contentHash: "hash1",
  },
  {
    id: "issued-asset-payment",
    version: 1,
    name: "Issued asset payment",
    description: "Issue TESTUSD and send it to a recipient through a trustline.",
    contentHash: "hash2",
  },
  {
    id: "missing-trustline",
    version: 1,
    name: "Missing trustline",
    description: "Verify that an asset payment fails when the recipient has no trustline.",
    contentHash: "hash3",
  },
];

const mockRun: RunReport = {
  id: "run-123",
  scenarioId: "test-scenario",
  scenarioVersion: 1,
  scenarioSchemaVersion: 1,
  scenarioContentHash: "hash",
  network: "testnet",
  status: "passed",
  createdAt: new Date().toISOString(),
  steps: [],
  assertions: [],
  summary: { stepsPassed: 0, stepsFailed: 0, assertionsPassed: 0, assertionsFailed: 0 },
};

const mixedOutcomeRun: RunReport = {
  ...mockRun,
  status: "failed",
  steps: [
    { id: "create-account", type: "create_account", status: "passed", message: "PASSING STEP MESSAGE" },
    { id: "send-payment", type: "payment", status: "failed", message: "FAILING STEP MESSAGE" },
  ],
  assertions: [
    { type: "balance", status: "passed", expected: "100", actual: "100", message: "PASSING ASSERTION MESSAGE" },
    { type: "payment", status: "failed", expected: "50", actual: "0", message: "FAILING ASSERTION MESSAGE" },
  ],
  summary: { stepsPassed: 1, stepsFailed: 1, assertionsPassed: 1, assertionsFailed: 1 },
};

const allPassRun: RunReport = {
  ...mockRun,
  steps: [{ id: "create-account", type: "create_account", status: "passed", message: "ALL PASS STEP MESSAGE" }],
  assertions: [{ type: "balance", status: "passed", expected: "100", actual: "100", message: "ALL PASS ASSERTION MESSAGE" }],
  summary: { stepsPassed: 1, stepsFailed: 0, assertionsPassed: 1, assertionsFailed: 0 },
};

const timedOutRun: RunReport = {
  ...allPassRun,
  status: "failed",
  error: {
    code: "RUN_TIMEOUT",
    message: "The run exceeded its time limit.",
    category: "timeout",
    retryable: false,
  },
};

function changeDocumentVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("filterScenario helper", () => {
  it("includes all scenarios when filter is 'all'", () => {
    mockScenarios.forEach((scenario) => {
      expect(filterScenario(scenario, "all")).toBe(true);
    });
  });

  it("filters XLM scenarios correctly", () => {
    expect(filterScenario(mockScenarios[0], "xlm")).toBe(true);
    expect(filterScenario(mockScenarios[1], "xlm")).toBe(false);
    expect(filterScenario(mockScenarios[2], "xlm")).toBe(false);
  });

  it("filters Issued Asset scenarios correctly", () => {
    expect(filterScenario(mockScenarios[0], "issued-asset")).toBe(false);
    expect(filterScenario(mockScenarios[1], "issued-asset")).toBe(true);
    expect(filterScenario(mockScenarios[2], "issued-asset")).toBe(false);
  });

  it("filters Expected Failure scenarios correctly", () => {
    expect(filterScenario(mockScenarios[0], "expected-failure")).toBe(false);
    expect(filterScenario(mockScenarios[1], "expected-failure")).toBe(false);
    expect(filterScenario(mockScenarios[2], "expected-failure")).toBe(true);
  });
});

describe("Dashboard component scenario filtering", () => {
  beforeEach(() => {
    vi.spyOn(api, "listScenarios").mockResolvedValue(mockScenarios);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });


  it("renders all scenarios by default with 'All' filter active", async () => {
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByText("03 AVAILABLE")).toBeDefined();
    });

    const allTab = screen.getByRole("tab", { name: "All" });
    expect(allTab.getAttribute("aria-selected")).toBe("true");

    expect(screen.getAllByText("XLM payment").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Issued asset payment").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Missing trustline").length).toBeGreaterThan(0);
  });

  it("filters scenarios when clicking 'XLM'", async () => {
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByText("03 AVAILABLE")).toBeDefined();
    });

    const xlmTab = screen.getByRole("tab", { name: "XLM" });
    fireEvent.click(xlmTab);

    expect(xlmTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("01 AVAILABLE")).toBeDefined();
    expect(screen.getAllByText("XLM payment").length).toBeGreaterThan(0);
    expect(screen.queryByText("Issued asset payment")).toBeNull();
    expect(screen.queryByText("Missing trustline")).toBeNull();
  });

  it("filters scenarios when clicking 'Issued Asset'", async () => {
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByText("03 AVAILABLE")).toBeDefined();
    });

    const issuedTab = screen.getByRole("tab", { name: "Issued Asset" });
    fireEvent.click(issuedTab);

    expect(issuedTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("01 AVAILABLE")).toBeDefined();
    expect(screen.queryByText("XLM payment")).toBeNull();
    expect(screen.getAllByText("Issued asset payment").length).toBeGreaterThan(0);
    expect(screen.queryByText("Missing trustline")).toBeNull();
  });

  it("filters scenarios when clicking 'Expected Failure'", async () => {
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByText("03 AVAILABLE")).toBeDefined();
    });

    const failureTab = screen.getByRole("tab", { name: "Expected Failure" });
    fireEvent.click(failureTab);

    expect(failureTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("01 AVAILABLE")).toBeDefined();
    expect(screen.queryByText("XLM payment")).toBeNull();
    expect(screen.queryByText("Issued asset payment")).toBeNull();
    expect(screen.getAllByText("Missing trustline").length).toBeGreaterThan(0);
  });

  it("displays empty results message when no scenarios match filter", async () => {
    vi.spyOn(api, "listScenarios").mockResolvedValue([mockScenarios[0]]); // Only XLM scenario

    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByText("01 AVAILABLE")).toBeDefined();
    });

    const failureTab = screen.getByRole("tab", { name: "Expected Failure" });
    fireEvent.click(failureTab);

    expect(screen.getByText("00 AVAILABLE")).toBeDefined();
    expect(screen.getByText("No scenarios found")).toBeDefined();
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
  });
});

describe("Dashboard report filtering", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockSearchParams = new URLSearchParams("?runId=run-123");
    vi.spyOn(api, "listScenarios").mockResolvedValue(mockScenarios);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    mockSearchParams = new URLSearchParams();
  });

  it("filters mixed step and assertion outcomes without changing run totals", async () => {
    vi.spyOn(api, "getRun").mockResolvedValue(mixedOutcomeRun);

    render(<Dashboard />);
    await screen.findByText("PASSING STEP MESSAGE");
    const reportFilters = within(screen.getByRole("group", { name: "Report filter" }));

    fireEvent.click(reportFilters.getByRole("button", { name: "Failed" }));

    expect(reportFilters.getByRole("button", { name: "Failed" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("PASSING STEP MESSAGE").closest(".report-row")).toHaveAttribute("hidden");
    expect(screen.getByText("PASSING ASSERTION MESSAGE").closest(".report-row")).toHaveAttribute("hidden");
    expect(screen.getByText("FAILING STEP MESSAGE")).toBeDefined();
    expect(screen.getByText("FAILING ASSERTION MESSAGE")).toBeDefined();
    expect(screen.getByText("Steps passed").parentElement?.querySelector("dd")?.textContent).toBe("1");
    expect(screen.getByText("Steps failed").parentElement?.querySelector("dd")?.textContent).toBe("1");
    expect(screen.getByText("Assertions passed").parentElement?.querySelector("dd")?.textContent).toBe("1");
    expect(screen.getByText("Assertions failed").parentElement?.querySelector("dd")?.textContent).toBe("1");
  });

  it("shows a distinct empty state when an all-pass report has no failed checks", async () => {
    vi.spyOn(api, "getRun").mockResolvedValue(allPassRun);

    render(<Dashboard />);
    await screen.findByText("ALL PASS STEP MESSAGE");
    const reportFilters = within(screen.getByRole("group", { name: "Report filter" }));
    fireEvent.click(reportFilters.getByRole("button", { name: "Failed" }));

    expect(screen.getByText("No failed checks")).toBeDefined();
    expect(screen.getByText("No steps or assertions are currently marked as failed.")).toBeDefined();
    expect(screen.getByText("ALL PASS STEP MESSAGE").closest(".report-row")).toHaveAttribute("hidden");
    expect(screen.getByText("ALL PASS ASSERTION MESSAGE").closest(".report-row")).toHaveAttribute("hidden");
  });

  it("keeps run-level timeout errors visible with no failed rows", async () => {
    vi.spyOn(api, "getRun").mockResolvedValue(timedOutRun);

    render(<Dashboard />);
    await screen.findByText("RUN_TIMEOUT");
    expect(screen.getByText("ALL PASS STEP MESSAGE")).toBeDefined();
    const reportFilters = within(screen.getByRole("group", { name: "Report filter" }));
    fireEvent.click(reportFilters.getByRole("button", { name: "Failed" }));

    expect(screen.getByText("No failed checks")).toBeDefined();
    expect(screen.getByText("The run timed out before any step or assertion was marked as failed.")).toBeDefined();
    expect(screen.getByText("RUN_TIMEOUT")).toBeDefined();
    expect(screen.getByText("The run exceeded its time limit.")).toBeDefined();
    expect(screen.getByText("ALL PASS STEP MESSAGE").closest(".report-row")).toHaveAttribute("hidden");
  });

  it("opens the browser print flow for a terminal report", async () => {
    const printMock = vi.spyOn(window, "print").mockImplementation(() => undefined);
    vi.spyOn(api, "getRun").mockResolvedValue(mixedOutcomeRun);

    render(<Dashboard />);
    await screen.findByText("FAILING STEP MESSAGE");
    fireEvent.click(screen.getByRole("button", { name: "Print report" }));

    expect(printMock).toHaveBeenCalledOnce();
  });
});

describe("Dashboard component catalogue loading and retry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("handles initial failure and repeated failure", async () => {
    const listScenariosMock = vi.spyOn(api, "listScenarios").mockRejectedValue(new Error("Network Error"));

    render(<Dashboard />);
    
    // Wait for the failure to render
    await waitFor(() => {
      expect(screen.getByText("Couldn't load scenarios")).toBeDefined();
    });
    expect(screen.getByText("Network Error")).toBeDefined();
    
    const retryButton = screen.getByRole("button", { name: "Retry" });
    
    // Repeated failure
    listScenariosMock.mockRejectedValueOnce(new Error("Still Failed"));
    fireEvent.click(retryButton);
    
    await waitFor(() => {
      expect(screen.getByText("Still Failed")).toBeDefined();
    });
  });

  it("handles successful retry after failure", async () => {
    const listScenariosMock = vi.spyOn(api, "listScenarios").mockRejectedValueOnce(new Error("Network Error"));
    
    render(<Dashboard />);
    
    await waitFor(() => {
      expect(screen.getByText("Couldn't load scenarios")).toBeDefined();
    });
    
    // Setup for success
    listScenariosMock.mockResolvedValueOnce(mockScenarios);
    
    const retryButton = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retryButton);
    
    // Should clear error and show scenarios
    await waitFor(() => {
      expect(screen.queryByText("Couldn't load scenarios")).toBeNull();
      expect(screen.getAllByText("XLM payment").length).toBeGreaterThan(0);
    });
  });

  it("displays distinct empty success state", async () => {
    vi.spyOn(api, "listScenarios").mockResolvedValue([]);
    
    render(<Dashboard />);
    
    await waitFor(() => {
      expect(screen.getByText("No scenarios found")).toBeDefined();
      expect(screen.getByText("No scenarios match the selected filter (\"All\").")).toBeDefined();
      expect(screen.queryByText("Couldn't load scenarios")).toBeNull();
    });
  });

  it("aborts requests on unmount", () => {
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    const { unmount } = render(<Dashboard />);
    unmount();
    expect(abortSpy).toHaveBeenCalled();
  });
});

describe("Dashboard URL Restoration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockSearchParams = new URLSearchParams();
    vi.spyOn(api, "listScenarios").mockResolvedValue([mockScenarios[0]]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("updates URL with runId without reloading when startRun is called", async () => {
    const startRunMock = vi.spyOn(api, "startRun").mockResolvedValue(mockRun);
    
    render(<Dashboard />);
    
    // Wait for scenarios to load
    const elements = await screen.findAllByText("XLM payment");
    
    // Click scenario to select it
    fireEvent.click(elements[0]);
    
    // Click run
    const runButton = screen.getByRole("button", { name: /Run on Testnet/i });
    fireEvent.click(runButton);
    
    await waitFor(() => {
      expect(startRunMock).toHaveBeenCalledWith("xlm-payment");
    });
    
    expect(mockReplace).toHaveBeenCalledWith("/dashboard?runId=run-123", { scroll: false });
  });

  it("restores run when runId is in URL", async () => {
    mockSearchParams = new URLSearchParams("?runId=run-456");
    const getRunMock = vi.spyOn(api, "getRun").mockResolvedValue({ ...mockRun, id: "run-456" });
    const startRunMock = vi.spyOn(api, "startRun");
    
    render(<Dashboard />);
    
    // Should show restoring state immediately
    expect(screen.getByText("Restoring run...")).toBeDefined();
    
    // Should call getRun
    expect(getRunMock).toHaveBeenCalledWith("run-456", expect.any(AbortSignal));
    
    // Should display the run ID eventually
    await screen.findByText("run-456");
    expect(startRunMock).not.toHaveBeenCalled(); // Absense of POST request on restore
  });

  it("shows unavailable state for missing run", async () => {
    mockSearchParams = new URLSearchParams("?runId=invalid-run");
    const getRunMock = vi.spyOn(api, "getRun").mockRejectedValue(new Error("Not found"));
    
    render(<Dashboard />);
    
    // Should show error state
    await screen.findByText("Run unavailable");
    expect(screen.getByText("Not found")).toBeDefined();
    
    // Clicking dismiss clears URL
    const dismissButton = screen.getByRole("button", { name: /Dismiss/i });
    fireEvent.click(dismissButton);
    
    expect(mockReplace).toHaveBeenCalledWith("/dashboard", { scroll: false });
  });
});

describe("Dashboard Sequential Polling and Recovery", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockSearchParams = new URLSearchParams("?runId=run-123");
    vi.spyOn(api, "listScenarios").mockResolvedValue([mockScenarios[0]]);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    cleanup();
    Reflect.deleteProperty(document, "visibilityState");
    vi.restoreAllMocks();
  });

  it("polls sequentially with exponential backoff on transient failures", async () => {
    const getRunMock = vi.spyOn(api, "getRun")
      .mockResolvedValueOnce({ ...mockRun, status: "pending" })
      .mockRejectedValueOnce(new Error("Network glitch 1"))
      .mockRejectedValueOnce(new Error("Network glitch 2"))
      .mockResolvedValueOnce({ ...mockRun, status: "passed" });

    render(<Dashboard />);

    await act(async () => { await Promise.resolve(); });
    expect(getRunMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("run-123")).toBeDefined(); 

    await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve(); });
    expect(getRunMock).toHaveBeenCalledTimes(2); 

    expect(screen.getByText("Monitoring paused")).toBeDefined();
    expect(screen.getByText("Network glitch 1")).toBeDefined();

    await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve(); });
    expect(getRunMock).toHaveBeenCalledTimes(3); 

    expect(screen.getByText("Network glitch 2")).toBeDefined();

    await act(async () => { vi.advanceTimersByTime(2000); await Promise.resolve(); });
    expect(getRunMock).toHaveBeenCalledTimes(4); 

    expect(screen.queryByText("Monitoring paused")).toBeNull();
  });

  it("retains the failed report filter when polling updates the run", async () => {
    const initialRun = { ...mixedOutcomeRun, status: "running" as const };
    const updatedRun = {
      ...initialRun,
      steps: [...initialRun.steps, { id: "verify-ledger", type: "ledger", status: "passed" as const, message: "POLLING UPDATE PASS MESSAGE" }],
    };
    const getRunMock = vi.spyOn(api, "getRun")
      .mockResolvedValueOnce(initialRun)
      .mockResolvedValueOnce(updatedRun);

    render(<Dashboard />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText("PASSING STEP MESSAGE")).toBeDefined();

    const reportFilters = within(screen.getByRole("group", { name: "Report filter" }));
    fireEvent.click(reportFilters.getByRole("button", { name: "Failed" }));
    expect(screen.getByText("FAILING STEP MESSAGE")).toBeDefined();
    expect(screen.getByText("PASSING STEP MESSAGE").closest(".report-row")).toHaveAttribute("hidden");

    await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve(); });

    expect(getRunMock).toHaveBeenCalledTimes(2);
    expect(reportFilters.getByRole("button", { name: "Failed" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("FAILING STEP MESSAGE")).toBeDefined();
    expect(screen.getByText("POLLING UPDATE PASS MESSAGE").closest(".report-row")).toHaveAttribute("hidden");
  });

  it("stops scheduling while hidden and refreshes immediately when visible", async () => {
    const getRunMock = vi.spyOn(api, "getRun")
      .mockResolvedValueOnce({ ...mockRun, status: "pending" })
      .mockResolvedValueOnce({ ...mockRun, status: "pending", createdAt: "2026-01-01T00:00:00.000Z" })
      .mockResolvedValueOnce({ ...mockRun, status: "pending", createdAt: "2026-01-02T00:00:00.000Z" });

    render(<Dashboard />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(getRunMock).toHaveBeenCalledTimes(1);

    act(() => { changeDocumentVisibility("hidden"); });
    await act(async () => { vi.advanceTimersByTime(5000); await Promise.resolve(); });
    expect(getRunMock).toHaveBeenCalledTimes(1);

    await act(async () => { changeDocumentVisibility("visible"); await Promise.resolve(); });
    expect(getRunMock).toHaveBeenCalledTimes(2);

    await act(async () => { vi.advanceTimersByTime(999); await Promise.resolve(); });
    expect(getRunMock).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve(); });
    expect(getRunMock).toHaveBeenCalledTimes(3);
  });

  it("aborts an in-flight refresh on hide and ignores its stale result", async () => {
    let resolveInFlight!: (value: RunReport) => void;
    let inFlightSignal: AbortSignal | undefined;
    const getRunMock = vi.spyOn(api, "getRun")
      .mockResolvedValueOnce({ ...mockRun, status: "pending" })
      .mockImplementationOnce((_runId, signal) => {
        inFlightSignal = signal;
        return new Promise((resolve) => { resolveInFlight = resolve; });
      })
      .mockResolvedValueOnce({ ...mockRun, status: "passed" });

    render(<Dashboard />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve(); });
    expect(getRunMock).toHaveBeenCalledTimes(2);

    act(() => { changeDocumentVisibility("hidden"); });
    expect(inFlightSignal?.aborted).toBe(true);

    await act(async () => {
      resolveInFlight({ ...mockRun, id: "stale-run", status: "failed" });
      await Promise.resolve();
    });
    expect(screen.getAllByText("Pending").length).toBeGreaterThan(0);
    expect(screen.queryByText("stale-run")).toBeNull();

    await act(async () => { changeDocumentVisibility("visible"); await Promise.resolve(); });
    expect(getRunMock).toHaveBeenCalledTimes(3);
    expect(screen.getAllByText("Passed").length).toBeGreaterThan(0);

    act(() => { changeDocumentVisibility("hidden"); });
    act(() => { changeDocumentVisibility("visible"); });
    await act(async () => { vi.advanceTimersByTime(5000); await Promise.resolve(); });
    expect(getRunMock).toHaveBeenCalledTimes(3);
  });

  it("removes the visibility listener and scheduled timer on unmount", async () => {
    const addListener = vi.spyOn(document, "addEventListener");
    const removeListener = vi.spyOn(document, "removeEventListener");
    const getRunMock = vi.spyOn(api, "getRun").mockResolvedValue({ ...mockRun, status: "pending" });
    const { unmount } = render(<Dashboard />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const visibilityListener = addListener.mock.calls.find(([type]) => type === "visibilitychange")?.[1];
    expect(visibilityListener).toBeDefined();
    const callsBeforeUnmount = getRunMock.mock.calls.length;

    unmount();
    expect(removeListener).toHaveBeenCalledWith("visibilitychange", visibilityListener);
    await act(async () => { vi.advanceTimersByTime(5000); await Promise.resolve(); });
    expect(getRunMock).toHaveBeenCalledTimes(callsBeforeUnmount);
  });

  it("stops polling and clears run when RUN_NOT_FOUND occurs", async () => {
    const notFoundError = new api.ApiError("Not Found", "RUN_NOT_FOUND");
    const getRunMock = vi.spyOn(api, "getRun")
      .mockResolvedValueOnce({ ...mockRun, status: "pending" })
      .mockRejectedValueOnce(notFoundError);

    render(<Dashboard />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("run-123")).toBeDefined();

    await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve(); });

    expect(screen.getByText("Couldn't complete the request")).toBeDefined();
    expect(screen.getByText("The requested run could not be found. It may have expired.")).toBeDefined();

    expect(mockReplace).toHaveBeenCalledWith("/dashboard", { scroll: false });

    const callCount = getRunMock.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(10000); await Promise.resolve(); });
    expect(getRunMock).toHaveBeenCalledTimes(callCount);
  });

  it("exposes Resume Monitoring button when retries are exhausted", async () => {
    const getRunMock = vi.spyOn(api, "getRun")
      .mockResolvedValueOnce({ ...mockRun, status: "pending" });

    for (let i = 0; i < 5; i++) {
      getRunMock.mockRejectedValueOnce(new Error(`Fail ${i}`));
    }

    render(<Dashboard />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("run-123")).toBeDefined();

    await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(2000); await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(4000); await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(8000); await Promise.resolve(); });

    const resumeBtn = screen.getByRole("button", { name: "Resume Monitoring" });
    expect(resumeBtn).toBeDefined();
    
    const callCount = getRunMock.mock.calls.length;
    expect(callCount).toBe(6); 
    await act(async () => { vi.advanceTimersByTime(20000); await Promise.resolve(); });
    expect(getRunMock).toHaveBeenCalledTimes(6); 

    getRunMock.mockResolvedValueOnce({ ...mockRun, status: "pending" });
    act(() => { fireEvent.click(resumeBtn); });

    await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve(); });
    expect(getRunMock).toHaveBeenCalledTimes(7);
  });

});
describe("Scenario definition preview, rate limiting, and ARIA announcements (#32, #39, #42)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockSearchParams = new URLSearchParams();
    vi.spyOn(api, "listScenarios").mockResolvedValue(mockScenarios);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders polite ARIA live region for screen readers (#42)", async () => {
    render(<Dashboard />);
    await act(async () => { await Promise.resolve(); });

    const liveRegion = document.getElementById("run-live-region");
    expect(liveRegion).not.toBeNull();
    expect(liveRegion?.getAttribute("role")).toBe("status");
    expect(liveRegion?.getAttribute("aria-live")).toBe("polite");
  });

  it("opens scenario preview panel and fetches detail when Details button is clicked (#32)", async () => {
    const mockDetail: api.ScenarioDetail = {
      id: "xlm-payment",
      version: 1,
      name: "XLM payment",
      description: "Detailed description of XLM payment.",
      contentHash: "hash-full-123456789",
      network: "testnet",
      schemaVersion: 1,
      accounts: [{ id: "acc1", label: "Sender" }],
      assets: [{ code: "XLM", issuer: "native" }],
      steps: [{ id: "step1", description: "Send payment" }],
      assertions: [{ id: "ast1", description: "Balance check" }],
    };
    vi.spyOn(api, "getScenario").mockResolvedValueOnce(mockDetail);

    render(<Dashboard />);
    await act(async () => { await Promise.resolve(); });

    const detailsBtn = screen.getByLabelText("Preview definition for XLM payment");
    expect(detailsBtn).toBeDefined();

    await act(async () => {
      fireEvent.click(detailsBtn);
    });

    expect(screen.getByRole("dialog", { name: "Scenario definition preview" })).toBeDefined();
    await waitFor(() => {
      expect(screen.getByText("Detailed description of XLM payment.")).toBeDefined();
      expect(screen.getByText("hash-full-123456789")).toBeDefined();
    });
  });

  it("handles 429 RateLimitError with retry countdown (#39)", async () => {
    vi.spyOn(api, "startRun").mockRejectedValueOnce(
      new api.RateLimitError("Rate limit reached", 429, 15)
    );

    render(<Dashboard />);
    await act(async () => { await Promise.resolve(); });

    // Click the scenario card by ID
    const card = document.getElementById("scenario-card-xlm-payment");
    expect(card).not.toBeNull();
    await act(async () => {
      fireEvent.click(card!);
    });

    const runBtn = screen.getByRole("button", { name: /Run on Testnet/i });
    await act(async () => {
      fireEvent.click(runBtn);
    });

    expect(screen.getByText(/Rate limited. Retry in 15s./i)).toBeDefined();
    expect(screen.getByRole("button", { name: /Retry in 15s/i })).toBeDefined();
  });
});

describe("Structured Stellar failure details (Issue #46)", () => {
  beforeEach(() => {
    mockSearchParams = new URLSearchParams();
    cleanup();
    vi.restoreAllMocks();
    vi.spyOn(api, "listScenarios").mockResolvedValue(mockScenarios);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders plain-language labels and optional codes for stellar failure", async () => {
    const stellarFailRun: RunReport = {
      ...mockRun,
      status: "failed",
      steps: [{ id: "pay", type: "payment", status: "failed", message: "Tx underfunded" }],
      error: {
        code: "STELLAR_TX_FAILED",
        message: "Operation underfunded",
        category: "stellar",
        retryable: true,
        failedStepId: "pay",
        stellarTransactionCode: "tx_failed",
        stellarOperationCodes: ["op_underfunded"],
      },
    };
    vi.spyOn(api, "startRun").mockResolvedValue(stellarFailRun);

    render(<Dashboard />);
    const runBtn = screen.getByRole("button", { name: /Run on Testnet/i });
    await waitFor(() => expect(runBtn).not.toBeDisabled());
    fireEvent.click(runBtn);
    await waitFor(() => expect(screen.getByText("STELLAR_TX_FAILED")).toBeDefined());

    expect(screen.getByText("Stellar network failure")).toBeDefined();
    expect(screen.getByText("Retryable failure")).toBeDefined();
    expect(screen.getByText("TX CODE:")).toBeDefined();
    expect(screen.getByText("tx_failed")).toBeDefined();
    expect(screen.getByText("OP CODES:")).toBeDefined();
    expect(screen.getByText("op_underfunded")).toBeDefined();

    const failedStepLink = screen.getByRole("link", { name: "Pay" });
    expect(failedStepLink.getAttribute("href")).toBe("#step-pay");
  });

  it("does not render empty labels when optional Stellar codes and failedStepId are absent", async () => {
    const timeoutRun: RunReport = {
      ...mockRun,
      status: "failed",
      error: {
        code: "TIMEOUT_ERROR",
        message: "Operation timed out",
        category: "timeout",
        retryable: false,
      },
    };
    vi.spyOn(api, "startRun").mockResolvedValue(timeoutRun);

    render(<Dashboard />);
    const runBtn = screen.getByRole("button", { name: /Run on Testnet/i });
    await waitFor(() => expect(runBtn).not.toBeDisabled());
    fireEvent.click(runBtn);
    await waitFor(() => expect(screen.getByText("TIMEOUT_ERROR")).toBeDefined());

    expect(screen.getByText("Execution timed out")).toBeDefined();
    expect(screen.getByText("Non-retryable failure")).toBeDefined();
    expect(screen.queryByText("TX CODE:")).toBeNull();
    expect(screen.queryByText("OP CODES:")).toBeNull();
    expect(screen.queryByText("FAILED STEP:")).toBeNull();
  });

  it("sanitizes internal failures and removes raw stack traces", async () => {
    const internalRun: RunReport = {
      ...mockRun,
      status: "failed",
      error: {
        code: "INTERNAL_ERROR",
        message: "Database connection failed\n    at Client.connect (/app/db.js:42:15)\n    at Object.handler (/app/route.js:10:8)",
        category: "internal",
        retryable: false,
      },
    };
    vi.spyOn(api, "startRun").mockResolvedValue(internalRun);

    render(<Dashboard />);
    const runBtn = screen.getByRole("button", { name: /Run on Testnet/i });
    await waitFor(() => expect(runBtn).not.toBeDisabled());
    fireEvent.click(runBtn);
    await waitFor(() => expect(screen.getByText("INTERNAL_ERROR")).toBeDefined());

    expect(screen.getByText("Internal system error")).toBeDefined();
    expect(screen.getByText("Database connection failed")).toBeDefined();
    expect(screen.queryByText(/at Client\.connect/)).toBeNull();
  });
});

describe("Offline report review (Issue #47)", () => {
  beforeEach(() => {
    mockSearchParams = new URLSearchParams();
    cleanup();
    vi.restoreAllMocks();
    vi.spyOn(api, "listScenarios").mockResolvedValue(mockScenarios);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("imports valid JSON report offline without starting a run or polling", async () => {
    const getRunSpy = vi.spyOn(api, "getRun");
    const startRunSpy = vi.spyOn(api, "startRun");

    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("03 AVAILABLE")).toBeDefined());

    const input = screen.getByTestId("offline-report-input");
    const validReportJson = JSON.stringify({
      ...mockRun,
      id: "offline-run-789",
      steps: [{ id: "step-1", type: "payment", status: "passed", message: "Step done" }],
    });
    const file = new File([validReportJson], "report.json", { type: "application/json" });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText("offline-run-789")).toBeDefined());
    expect(screen.getByText("Offline Evidence (Unverified)")).toBeDefined();
    expect(getRunSpy).not.toHaveBeenCalled();
    expect(startRunSpy).not.toHaveBeenCalled();
  });

  it("rejects oversized report files and preserves current state", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("03 AVAILABLE")).toBeDefined());

    const input = screen.getByTestId("offline-report-input");
    const oversizedFile = new File(["x".repeat(6 * 1024 * 1024)], "huge.json", { type: "application/json" });

    fireEvent.change(input, { target: { files: [oversizedFile] } });

    await waitFor(() => expect(screen.getByText(/File is too large/i)).toBeDefined());
  });

  it("rejects invalid JSON files with actionable error and preserves state", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("03 AVAILABLE")).toBeDefined());

    const input = screen.getByTestId("offline-report-input");
    const malformedFile = new File(["{ bad json"], "bad.json", { type: "application/json" });

    fireEvent.change(input, { target: { files: [malformedFile] } });

    await waitFor(() => expect(screen.getByText(/valid JSON document/i)).toBeDefined());
  });
});

describe("Report comparison view (Issue #48)", () => {
  beforeEach(() => {
    mockSearchParams = new URLSearchParams();
    cleanup();
    vi.restoreAllMocks();
    vi.spyOn(api, "listScenarios").mockResolvedValue(mockScenarios);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders comparison between two reports and warns when scenario content differs", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("03 AVAILABLE")).toBeDefined());

    // Switch to compare view
    fireEvent.click(screen.getByRole("tab", { name: "Compare" }));

    expect(screen.getByText("Select two reports to compare")).toBeDefined();

    const reportA: RunReport = {
      ...mockRun,
      id: "report-a",
      scenarioId: "scenario-1",
      scenarioVersion: 1,
      scenarioContentHash: "hash-1",
      status: "failed",
      createdAt: "2026-10-16T00:00:00.000Z",
      completedAt: "2026-10-16T00:00:10.000Z",
      steps: [{ id: "step-1", type: "payment", status: "failed", message: "Failed" }],
      assertions: [{ type: "balance", status: "failed", expected: "100", actual: "0", message: "Mismatch" }],
      summary: { stepsPassed: 0, stepsFailed: 1, assertionsPassed: 0, assertionsFailed: 1 },
    };

    const reportB: RunReport = {
      ...mockRun,
      id: "report-b",
      scenarioId: "scenario-2", // different scenario ID!
      scenarioVersion: 2,
      scenarioContentHash: "hash-2",
      status: "passed",
      createdAt: "2026-10-16T00:00:00.000Z",
      completedAt: "2026-10-16T00:00:15.000Z",
      steps: [
        { id: "step-1", type: "payment", status: "passed", message: "Passed" },
        { id: "step-2", type: "create_account", status: "passed", message: "Account created" },
      ],
      assertions: [
        { type: "balance", status: "passed", expected: "100", actual: "100", message: "Passed" },
        { type: "balance", status: "passed", expected: "50", actual: "50", message: "Second passed" },
      ],
      summary: { stepsPassed: 2, stepsFailed: 0, assertionsPassed: 2, assertionsFailed: 0 },
    };

    const fileA = new File([JSON.stringify(reportA)], "a.json", { type: "application/json" });
    const fileB = new File([JSON.stringify(reportB)], "b.json", { type: "application/json" });

    const inputA = screen.getByTestId("compare-file-a");
    const inputB = screen.getByTestId("compare-file-b");

    fireEvent.change(inputA, { target: { files: [fileA] } });
    fireEvent.change(inputB, { target: { files: [fileB] } });

    await waitFor(() => expect(screen.getByText("Warning: Different scenario content")).toBeDefined());
    expect(screen.getByText(/Failed → Passed/i)).toBeDefined();
    expect(screen.getByText(/diff: \+5\.0s/i)).toBeDefined();
    expect(screen.getByText(/0 unchanged, 1 changed, 1 added, 0 removed/i)).toBeDefined();
  });
});



