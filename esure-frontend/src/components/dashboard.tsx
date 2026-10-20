"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { ApiError, downloadReport, getRun, listScenarios, startRun, type JsonValue, type RunReport, type ScenarioSummary } from "@/lib/api";
import { ApiError, RateLimitError, getRun, getScenario, listScenarios, startRun, type JsonValue, type RunReport, type ScenarioDetail, type ScenarioSummary } from "@/lib/api";

const terminalStatuses = new Set(["passed", "failed"]);

export type ScenarioFilter = "all" | "xlm" | "issued-asset" | "expected-failure";
export type SortOrder = "name-asc" | "name-desc" | "id-asc";
export type ReportFilter = "all" | "failed";

export const FILTER_OPTIONS: { key: ScenarioFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "xlm", label: "XLM" },
  { key: "issued-asset", label: "Issued Asset" },
  { key: "expected-failure", label: "Expected Failure" },
];


export type ReportFilter = "all" | "failed";

export const REPORT_FILTER_OPTIONS: { key: ReportFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "failed", label: "Failed" },
];

export const SORT_OPTIONS: { key: SortOrder; label: string }[] = [
  { key: "name-asc", label: "Name A–Z" },
  { key: "name-desc", label: "Name Z–A" },
  { key: "id-asc", label: "ID A–Z" },
];

export function filterScenario(scenario: ScenarioSummary, filter: ScenarioFilter): boolean {
  if (filter === "all") return true;
  const text = `${scenario.id} ${scenario.name} ${scenario.description}`.toLowerCase();
  if (filter === "xlm") return text.includes("xlm");
  if (filter === "issued-asset") return text.includes("issued") || text.includes("testusd") || scenario.id === "issued-asset-payment";
  if (filter === "expected-failure") return text.includes("fail") || text.includes("missing-trustline") || scenario.id === "missing-trustline";
  return true;
}

export function searchScenario(scenario: ScenarioSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    scenario.name.toLowerCase().includes(q) ||
    scenario.id.toLowerCase().includes(q) ||
    scenario.description.toLowerCase().includes(q)
  );
}

export function sortScenarios(list: ScenarioSummary[], order: SortOrder): ScenarioSummary[] {
  const sorted = [...list];
  sorted.sort((a, b) => {
    if (order === "name-asc") {
      const cmp = a.name.localeCompare(b.name);
      return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
    }
    if (order === "name-desc") {
      const cmp = b.name.localeCompare(a.name);
      return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
    }
    // id-asc
    return a.id.localeCompare(b.id);
  });
  return sorted;
}

const VALID_CATEGORIES = new Set<string>(FILTER_OPTIONS.map((o) => o.key));

function parseCategory(value: string | null): ScenarioFilter {
  if (value && VALID_CATEGORIES.has(value)) return value as ScenarioFilter;
  return "all";
}

export function Dashboard() {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [run, setRun] = useState<RunReport | null>(null);
  const [reportFilter, setReportFilter] = useState<ReportFilter>("all");
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  const [pollingError, setPollingError] = useState<string | null>(null);
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  const [isOffline, setIsOffline] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"report" | "compare">("report");
  const [reportFilter, setReportFilter] = useState<ReportFilter>("all");

  // #32 — Scenario preview panel
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewScenario, setPreviewScenario] = useState<ScenarioDetail | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);

  // #39 — Rate-limit countdown (seconds remaining before retry is allowed)
  const [rateLimitCountdown, setRateLimitCountdown] = useState<number | null>(null);
  const rateLimitTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // #42 — ARIA live region: tracks last announcement to deduplicate
  const [liveAnnouncement, setLiveAnnouncement] = useState<string>("");
  const lastAnnouncedRef = useRef<string>("");

  // Search state — preserved while a run is in progress (#29)
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Sort state (#30)
  const [sortOrder, setSortOrder] = useState<SortOrder>("name-asc");

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const runIdParam = searchParams?.get("runId");

  // --- #31: read category from URL on first render ---
  const [filter, setFilter] = useState<ScenarioFilter>(() =>
    parseCategory(searchParams?.get("category") ?? null),
  );

  // Sync filter <-> URL (without clobbering other params)
  const prevFilterRef = useRef<ScenarioFilter>(filter);
  useEffect(() => {
    if (prevFilterRef.current === filter) return;
    prevFilterRef.current = filter;
    const newParams = new URLSearchParams(searchParams?.toString() ?? "");
    if (filter === "all") {
      newParams.delete("category");
    } else {
      newParams.set("category", filter);
    }
    router.replace(pathname + (newParams.toString() ? "?" + newParams.toString() : ""), { scroll: false });
  }, [filter, pathname, router, searchParams]);

  // Keep filter in sync when URL changes via back/forward (#31)
  const urlCategory = searchParams?.get("category") ?? null;
  useEffect(() => {
    const parsed = parseCategory(urlCategory);
    setFilter((prev) => (prev !== parsed ? parsed : prev));
  }, [urlCategory]);

  const [restoringRun, setRestoringRun] = useState(false);
  const [restorationError, setRestorationError] = useState<string | null>(null);

  useEffect(() => {
    if (!runIdParam || run) return;
    
    let active = true;
    const controller = new AbortController();
    setRestoringRun(true);
    setRestorationError(null);

    getRun(runIdParam, controller.signal)
      .then((restored) => {
        if (!active) return;
        setRun(restored);
        setSelectedId(restored.scenarioId);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setRestorationError(readError(reason));
      })
      .finally(() => {
        if (active) setRestoringRun(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [runIdParam, run]);

  function clearRestoration() {
    setRestorationError(null);
    const newParams = new URLSearchParams(searchParams?.toString() ?? "");
    newParams.delete("runId");
    router.replace(pathname + (newParams.toString() ? "?" + newParams.toString() : ""), { scroll: false });
  }


  // #32 — Load scenario detail on-demand, cancel stale requests
  useEffect(() => {
    if (!previewId) {
      setPreviewScenario(null);
      setPreviewError(null);
      return;
    }
    previewAbortRef.current?.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;
    setPreviewLoading(true);
    setPreviewError(null);
    getScenario(previewId, controller.signal)
      .then((detail) => {
        if (controller.signal.aborted) return;
        setPreviewScenario(detail);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setPreviewError(readError(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewLoading(false);
      });
    return () => { controller.abort(); };
  }, [previewId]);

  // #39 — Clear rate-limit timer when it expires or component unmounts
  useEffect(() => {
    return () => {
      if (rateLimitTimerRef.current !== null) clearInterval(rateLimitTimerRef.current);
    };
  }, []);

  // #42 — Announce meaningful run lifecycle transitions to assistive technology
  const prevRunStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const currentStatus = run?.status ?? null;
    const prev = prevRunStatusRef.current;
    prevRunStatusRef.current = currentStatus;
    if (!currentStatus || currentStatus === prev) return;
    const scenarioName = run ? (scenarios.find((s) => s.id === run.scenarioId)?.name ?? run.scenarioId) : "";
    let message = "";
    if (prev === null && currentStatus && !terminalStatuses.has(currentStatus)) {
      message = `Run started for scenario ${scenarioName}.`;
    } else if (currentStatus === "passed") {
      message = `Run passed for scenario ${scenarioName}.`;
    } else if (currentStatus === "failed") {
      const failSummary = run?.summary
        ? `${run.summary.stepsFailed} step${run.summary.stepsFailed !== 1 ? "s" : ""} and ${run.summary.assertionsFailed} assertion${run.summary.assertionsFailed !== 1 ? "s" : ""} failed.`
        : "Check the report for details.";
      message = `Run failed for scenario ${scenarioName}. ${failSummary}`;
    }
    if (message && message !== lastAnnouncedRef.current) {
      lastAnnouncedRef.current = message;
      setLiveAnnouncement(message);
    }
  }, [run, scenarios]);

  const loadScenarios = useCallback(() => {
    let active = true;
    const controller = new AbortController();
    
    setLoading(true);
    setCatalogueError(null);
    
    listScenarios(controller.signal)
      .then((items) => {
        if (!active) return;
        setScenarios(items);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setCatalogueError(readError(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
      
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    return loadScenarios();
  }, [loadScenarios]);

  // Apply filter, search, and sort (#29, #30)
  const filteredScenarios = useMemo(() => {
    const filtered = scenarios.filter(
      (s) => filterScenario(s, filter) && searchScenario(s, searchQuery),
    );
    return sortScenarios(filtered, sortOrder);
  }, [scenarios, filter, searchQuery, sortOrder]);

  useEffect(() => {
    if (filteredScenarios.length > 0) {
      if (!filteredScenarios.some((s) => s.id === selectedId)) {
        setSelectedId(filteredScenarios[0].id);
      }
    } else {
      setSelectedId("");
    }
  }, [filteredScenarios, selectedId]);

  useEffect(() => {
    if (!run || isOffline || terminalStatuses.has(run.status)) return;
    if (consecutiveFailures >= 5) return; // Exhausted retries

    const activeRunId = run.id;
    let active = true;
    let timerId: number | null = null;
    let inFlightController: AbortController | null = null;
    let requestVersion = 0;
    let wasVisible = document.visibilityState !== "hidden";

    async function poll() {
      if (!active || !wasVisible || inFlightController) return;
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }

      const currentRequestVersion = ++requestVersion;
      const controller = new AbortController();
      inFlightController = controller;

      try {
        const updatedRun = await getRun(activeRunId, controller.signal);
        if (!active || !wasVisible || currentRequestVersion !== requestVersion) return;
        setRun(updatedRun);
        setConsecutiveFailures(0);
        setPollingError(null);
      } catch (reason: unknown) {
        if (!active || currentRequestVersion !== requestVersion) return;
        if (reason instanceof DOMException && reason.name === "AbortError") return;

        if (reason instanceof ApiError && reason.code === "RUN_NOT_FOUND") {
          setRun(null);
          clearRestoration(); // Clear from URL as well
          setError("The requested run could not be found. It may have expired.");
          return;
        }

        setPollingError(readError(reason));
        setConsecutiveFailures((prev) => prev + 1);
      } finally {
        if (inFlightController === controller) inFlightController = null;
      }
    }

    function schedule(delay: number) {
      if (!active || !wasVisible) return;
      timerId = window.setTimeout(() => {
        timerId = null;
        void poll();
      }, delay);
    }

    function handleVisibilityChange() {
      const visible = document.visibilityState !== "hidden";
      if (visible === wasVisible) return;
      wasVisible = visible;

      if (!visible) {
        if (timerId !== null) {
          window.clearTimeout(timerId);
          timerId = null;
        }
        requestVersion += 1;
        inFlightController?.abort();
        inFlightController = null;
        return;
      }

      void poll();
    }

    const delay = consecutiveFailures === 0 ? 1000 : Math.pow(2, consecutiveFailures - 1) * 1000;
    document.addEventListener("visibilitychange", handleVisibilityChange);
    schedule(delay);

    return () => {
      active = false;
      requestVersion += 1;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      inFlightController?.abort();
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, [run, isOffline, consecutiveFailures]);

  const selected = useMemo(() => scenarios.find((scenario) => scenario.id === selectedId), [scenarios, selectedId]);

  async function handleRun() {
    if (!selectedId) return;
    setIsOffline(false);
    setImportError(null);
    setViewMode("report");
    if (!selectedId || rateLimitCountdown !== null) return;
    setStarting(true);
    setError(null);
    setRun(null);
    try {
      const newRun = await startRun(selectedId);
      setRun(newRun);
      const newParams = new URLSearchParams(searchParams?.toString() ?? "");
      newParams.set("runId", newRun.id);
      router.replace(pathname + "?" + newParams.toString(), { scroll: false });
    } catch (reason) {
      if (reason instanceof RateLimitError) {
        const delay = reason.retryAfterSeconds ?? 10;
        setRateLimitCountdown(delay);
        if (rateLimitTimerRef.current !== null) clearInterval(rateLimitTimerRef.current);
        rateLimitTimerRef.current = setInterval(() => {
          setRateLimitCountdown((prev) => {
            if (prev === null || prev <= 1) {
              if (rateLimitTimerRef.current !== null) { clearInterval(rateLimitTimerRef.current); rateLimitTimerRef.current = null; }
              return null;
            }
            return prev - 1;
          });
        }, 1000);
        setError(`Rate limited. Retry in ${delay}s.`);
      } else {
        setError(readError(reason));
      }
    } finally {
      setStarting(false);
    }
  }

  async function handleImportReport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    if (file.size > MAX_REPORT_FILE_BYTES) {
      setImportError(`File is too large (${(file.size / (1024 * 1024)).toFixed(1)}MB). Maximum allowed size is 5MB.`);
      return;
    }
    try {
      const text = await file.text();
      const parsed = parseReportJson(text, MAX_REPORT_FILE_BYTES);
      setRun(parsed);
      setIsOffline(true);
      setImportError(null);
      setViewMode("report");
      const newParams = new URLSearchParams(searchParams?.toString() ?? "");
      newParams.delete("runId");
      router.replace(pathname + (newParams.toString() ? "?" + newParams.toString() : ""), { scroll: false });
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Failed to parse report file.");
    }
  }

  function handleExitOffline() {
    setIsOffline(false);
    setRun(null);
    setImportError(null);
  }
  const isRunning = !!run && !terminalStatuses.has(run.status);

  return (
    <main>
      <a
        href="#main-content"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault();
          const target = document.getElementById("main-content");
          if (target) {
            target.focus();
            target.scrollIntoView?.();
          }
        }}
      >
        Skip to main content
      </a>
      {/* #42 — Polite ARIA live region for run lifecycle announcements */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        id="run-live-region"
      >
        {liveAnnouncement}
      </div>
      <header className="topbar shell">
        <a className="brand" href="#top" aria-label="Esure home">
          <img className="brand-mark" src="/esure-mark.svg" width="38" height="38" alt="" aria-hidden="true" />
          <span>esure</span>
        </a>
        <a className="docs-link" href="https://developers.stellar.org" target="_blank" rel="noreferrer">Docs <ArrowIcon /></a>
      </header>

      <section className="hero shell" id="top">
        <div>
          <p className="eyebrow">PAYMENT SCENARIO LAB</p>
          <h1>Know it works<br /><span>before it ships.</span></h1>
          <p className="lede">Run repeatable Stellar payment flows on Testnet. See every operation, ledger confirmation, and assertion in one readable report.</p>
        </div>
        <div className="hero-orbit" aria-hidden="true">
          <div className="scene-glow" />
          <div className="scene-grid" />
          <div className="orbit-stage">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <div className="orbit orbit-three" />
            <span className="orbit-core"><span className="core-pulse" /><img src="/esure-mark.svg" width="66" height="66" alt="" /></span>
            <i className="satellite one" />
            <i className="satellite two" />
            <i className="satellite three" />
          </div>
          <div className="signal-card transaction-card"><span className="signal-icon">↗</span><span><b>Payment sent</b><small>100 TESTUSD</small></span></div>
          <div className="signal-card ledger-card"><span className="signal-dot" /><span><b>Ledger closed</b><small>3.4 seconds</small></span></div>
          <div className="verified-chip"><CheckIcon /> VERIFIED</div>
        </div>
      </section>

      <section className="workspace shell" id="main-content" tabIndex={-1}>
        <div className="section-heading">
          <div><p className="eyebrow">01 / CHOOSE A FLOW</p><h2>Test scenarios</h2></div>
          <span className="scenario-count">{filteredScenarios.length.toString().padStart(2, "0")} AVAILABLE</span>
        </div>

        {/* Filters row */}
        <div className="scenario-filters" role="tablist" aria-label="Scenario filter options">
          {FILTER_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              role="tab"
              aria-selected={filter === option.key}
              aria-controls="scenario-grid"
              className={`filter-pill ${filter === option.key ? "active" : ""}`}
              onClick={() => setFilter(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>

        {/* Search + Sort toolbar (#29 #30) */}
        <div className="catalogue-toolbar">
          <div className="search-field">
            <label htmlFor="scenario-search" className="search-label">Search</label>
            <div className="search-input-wrap">
              <SearchIcon />
              <input
                id="scenario-search"
                type="search"
                className="search-input"
                placeholder="Name, ID, or description…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Search scenarios by name, ID, or description"
              />
              {searchQuery && (
                <button
                  type="button"
                  className="search-clear"
                  aria-label="Clear search"
                  onClick={() => setSearchQuery("")}
                >
                  ×
                </button>
              )}
            </div>
          </div>

          <div className="sort-field">
            <label htmlFor="scenario-sort" className="sort-label">Sort</label>
            <div className="sort-select-wrap">
              <select
                id="scenario-sort"
                className="sort-select"
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value as SortOrder)}
                aria-label={`Sort scenarios: ${SORT_OPTIONS.find((o) => o.key === sortOrder)?.label}`}
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>{o.label}</option>
                ))}
              </select>
              <ChevronIcon />
            </div>
          </div>
        </div>

        {error && <div className="error-banner" role="alert"><WarningIcon /><div><strong>Couldn&apos;t complete the request</strong><span>{error}</span></div></div>}
        {pollingError && (
          <div className="error-banner" role="alert">
            <WarningIcon />
            <div>
              <strong>Monitoring paused</strong>
              <span>{pollingError}</span>
            </div>
            {consecutiveFailures >= 5 && (
              <button type="button" className="run-button run-button--secondary" style={{ marginLeft: "auto", minWidth: "auto", padding: "8px 12px" }} onClick={() => setConsecutiveFailures(0)}>
                Resume Monitoring
              </button>
            )}
          </div>
        )}

        <div className="scenario-grid" id="scenario-grid" aria-busy={loading}>
          {loading ? (
            [1, 2, 3].map((item) => <div className="scenario-card skeleton" key={item} />)
          ) : catalogueError ? (
            <div className="empty-scenarios" role="alert" aria-live="polite">
              <strong>Couldn&apos;t load scenarios</strong>
              <p>{catalogueError}</p>
              <button type="button" className="run-button run-button--secondary" style={{ marginTop: '16px', minWidth: 'auto', padding: '10px 16px' }} onClick={loadScenarios}>Retry</button>
            </div>
          ) : filteredScenarios.length === 0 ? (
            <div className="empty-scenarios" role="status" aria-live="polite">
              <strong>No scenarios found</strong>
              {searchQuery.trim() ? (
                <p>No scenarios match &quot;{searchQuery.trim()}&quot;. <button type="button" className="inline-clear" onClick={() => setSearchQuery("")}>Clear search</button></p>
              ) : (
                <p>No scenarios match the selected filter (&quot;{FILTER_OPTIONS.find((o) => o.key === filter)?.label}&quot;).</p>
              )}
            </div>
          ) : (
            filteredScenarios.map((scenario, index) => (
              <div
                role="button"
                tabIndex={0}
                className={`scenario-card ${selectedId === scenario.id ? "selected" : ""}`}
                key={scenario.id}
                id={`scenario-card-${scenario.id}`}
                onClick={() => setSelectedId(scenario.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedId(scenario.id);
                  }
                }}
              >
                <span className="card-index">0{index + 1}</span>
                <ScenarioIcon kind={scenario.id} />
                <span className="scenario-name">{scenario.name}</span>
                <span className="scenario-description">{scenario.description}</span>
                <span className="version">V{scenario.version}</span>
                <button
                  type="button"
                  className="preview-btn"
                  aria-label={`Preview definition for ${scenario.name}`}
                  aria-expanded={previewId === scenario.id}
                  onClick={(e) => { e.stopPropagation(); setPreviewId(previewId === scenario.id ? null : scenario.id); }}
                >
                  {previewId === scenario.id ? "Close" : "Details"}
                </button>
              </div>
            ))
          )}
        </div>

        {/* #32 — Scenario definition preview panel */}
        {previewId && (
          <div className="preview-panel" role="dialog" aria-label="Scenario definition preview" aria-modal="false">
            <div className="preview-header">
              <strong>{scenarios.find((s) => s.id === previewId)?.name ?? previewId}</strong>
              <button
                type="button"
                className="preview-close"
                aria-label="Close scenario preview"
                onClick={() => setPreviewId(null)}
              >
                ×
              </button>
            </div>
            {previewLoading && <div className="preview-loading"><span className="spinner" /><span>Loading definition…</span></div>}
            {previewError && <div className="preview-error" role="alert">{previewError}</div>}
            {!previewLoading && !previewError && previewScenario && (
              <div className="preview-body">
                <dl className="preview-meta">
                  <div><dt>ID</dt><dd><code>{previewScenario.id}</code></dd></div>
                  <div><dt>Version</dt><dd>{previewScenario.version}</dd></div>
                  <div><dt>Schema version</dt><dd>{previewScenario.schemaVersion}</dd></div>
                  <div><dt>Content hash</dt><dd className="hash-cell"><code>{previewScenario.contentHash}</code></dd></div>
                  <div><dt>Accounts</dt><dd>{previewScenario.accounts.length}</dd></div>
                  <div><dt>Assets</dt><dd>{previewScenario.assets.length}</dd></div>
                  <div><dt>Steps</dt><dd>{previewScenario.steps.length}</dd></div>
                  <div><dt>Assertions</dt><dd>{previewScenario.assertions.length}</dd></div>
                </dl>
                <p className="preview-description">{previewScenario.description}</p>
              </div>
            )}
          </div>
        )}

        <div className="launch-panel">
          <div><span className="label">SELECTED SCENARIO</span><strong>{selected?.name ?? "Choose a scenario"}</strong><span>{selected?.id ?? "—"}</span></div>
          <button
            className="run-button"
            type="button"
            disabled={!selected || starting || isRunning || rateLimitCountdown !== null}
            onClick={handleRun}
            aria-describedby={rateLimitCountdown !== null ? "rate-limit-countdown" : undefined}
          >
            {starting ? "Starting…" : isRunning ? "Running…" : rateLimitCountdown !== null ? `Retry in ${rateLimitCountdown}s` : "Run on Testnet"}<PlayIcon />
          </button>
          {rateLimitCountdown !== null && (
            <p id="rate-limit-countdown" className="rate-limit-note" role="status" aria-live="polite">
              Rate limited — you can try again in <strong>{rateLimitCountdown}s</strong>.
            </p>
          )}
        </div>
      </section>

      <section className="results shell">
        <div className="section-heading">
          <div><p className="eyebrow">02 / INSPECT THE RUN</p><h2>{viewMode === "compare" ? "Report comparison" : "Execution report"}</h2></div>
          <div className="report-controls">
            <div className="report-filters" role="tablist" aria-label="Result mode">
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === "report"}
                className={`filter-pill ${viewMode === "report" ? "active" : ""}`}
                onClick={() => setViewMode("report")}
              >
                Report
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === "compare"}
                className={`filter-pill ${viewMode === "compare" ? "active" : ""}`}
                onClick={() => setViewMode("compare")}
              >
                Compare
              </button>
            </div>
            {viewMode === "report" && (
              <label className="print-button" style={{ cursor: "pointer", display: "inline-flex", alignItems: "center" }}>
                Import offline report
                <input
                  type="file"
                  accept=".json,application/json"
                  data-testid="offline-report-input"
                  style={{ display: "none" }}
                  onChange={handleImportReport}
                />
              </label>
            )}
            {viewMode === "report" && run && (
              <>
                <div className="report-filters" role="group" aria-label="Report filter">
                  {REPORT_FILTER_OPTIONS.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      aria-pressed={reportFilter === option.key}
                      className={`filter-pill ${reportFilter === option.key ? "active" : ""}`}
                      onClick={() => setReportFilter(option.key)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {terminalStatuses.has(run.status) && (
                  <button type="button" className="print-button" onClick={() => window.print()}>
                    Print report
                  </button>
                )}
                <StatusBadge status={run.status} />
              </>
            )}
          </div>
        </div>

        {importError && (
          <div className="error-banner" role="alert">
            <WarningIcon />
            <div>
              <strong>Could not import report</strong>
              <span>{importError}</span>
            </div>
          </div>
        )}

        {isOffline && viewMode === "report" && (
          <div className="offline-evidence-banner" role="status" style={{ padding: "14px 18px", background: "#f5edd6", border: "1px solid #d4c59b", marginBottom: "16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <strong style={{ display: "block", fontSize: "14px" }}>Offline Evidence (Unverified)</strong>
              <span style={{ fontSize: "12px", color: "#615234" }}>Imported local report. This evidence has not been re-verified on Testnet.</span>
            </div>
            <button type="button" className="run-button run-button--secondary" style={{ padding: "8px 14px", minWidth: "auto", fontSize: "12px" }} onClick={handleExitOffline}>
              Exit Offline View
            </button>
          </div>
        )}

        {viewMode === "compare" ? (
          <ReportComparisonView currentRun={run} />
        ) : !run ? (
          restoringRun ? (
            <div className="empty-report">
              <div className="running-row" style={{ justifyContent: 'center' }}>
                <span className="spinner" />
                <div><strong>Restoring run...</strong></div>
              </div>
            </div>
          ) : restorationError ? (
            <div className="empty-report">
              <div className="empty-glyph"><WarningIcon /></div>
              <strong>Run unavailable</strong>
              <p>{restorationError}</p>
              <button type="button" className="run-button run-button--secondary" style={{ marginTop: '16px', minWidth: 'auto', padding: '10px 16px' }} onClick={clearRestoration}>Dismiss</button>
            </div>
          ) : (
            <EmptyReport />
          )
        ) : (
          <RunView
            run={run}
            isOffline={isOffline}
            reportFilter={reportFilter}
            scenarioName={scenarios.find((scenario) => scenario.id === run.scenarioId)?.name ?? run.scenarioId}
          />
        )}
      </section>

      <footer className="shell"><span>ESURE / TEST WITH CONFIDENCE</span><span>BUILT FOR STELLAR</span></footer>
    </main>
  );
}

function RunView({ run, reportFilter, scenarioName }: { run: RunReport; reportFilter: ReportFilter; scenarioName: string }) {
  const isTerminal = terminalStatuses.has(run.status);
  const [now, setNow] = useState(() => Date.now());
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    if (isTerminal) return;
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, [isTerminal, run.id]);

  const createdLabel = formatLocaleDateTime(run.createdAt);
  const completedLabel = run.completedAt ? formatLocaleDateTime(run.completedAt) : null;
  const durationLabel = run.completedAt
    ? computeDuration(run.createdAt, run.completedAt)
    : isTerminal
    ? (computeDuration(run.createdAt, run.createdAt) || "0s")
    : formatElapsed(run.createdAt, now);

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const report = await downloadReport(run.id);
      const jsonStr = JSON.stringify(report, null, 2);
      const blob = new Blob([jsonStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `esure-run-${run.id}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 404) {
          setDownloadError("Report expired or not found. Please run the scenario again.");
        } else if (err.status === 409) {
          setDownloadError("Report is not complete yet. Please wait for the run to finish.");
        } else if (err.status === 503) {
          setDownloadError("Backend service is temporarily unavailable. Please try again shortly.");
        } else {
          setDownloadError(err.message || "Failed to download report.");
        }
      } else if (err instanceof Error) {
        setDownloadError(err.message);
      } else {
        setDownloadError("An unexpected error occurred while downloading the report.");
      }
    } finally {
      setDownloading(false);
    }
  };

  const visibleSteps = run.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => reportFilter === "all" || step.status === "failed");
  const visibleAssertions = run.assertions
    .map((assertion, index) => ({ assertion, index }))
    .filter(({ assertion }) => reportFilter === "all" || assertion.status === "failed");

  return (
    <div className="report-grid">
      <div className="timeline-card">
        <div className="print-report-header">
          <p className="eyebrow">ESURE / STELLAR TESTNET</p>
          <h1>Execution report</h1>
          <dl>
            <div><dt>Scenario</dt><dd>{scenarioName}</dd></div>
            <div><dt>Scenario ID</dt><dd>{run.scenarioId}</dd></div>
            <div><dt>Scenario version</dt><dd>{run.scenarioVersion}</dd></div>
            <div><dt>Schema version</dt><dd>{run.scenarioSchemaVersion}</dd></div>
            <div><dt>Content hash</dt><dd>{run.scenarioContentHash}</dd></div>
            <div><dt>Status</dt><dd>{titleCase(run.status)}</dd></div>
          </dl>
        </div>
        <div className="report-meta">
          <span>RUN ID</span><div className="id-cell"><code>{run.id}</code><CopyButton value={run.id} label="run ID" /></div>
          <span>NETWORK</span><code>{run.network}</code>
          <span>CREATED</span><code title={run.createdAt}>{createdLabel}</code>
          {completedLabel ? <><span>COMPLETED</span><code title={run.completedAt}>{completedLabel}</code></> : null}
          {durationLabel ? <><span>DURATION</span><code aria-live="off" data-testid="run-duration">{durationLabel}</code></> : null}
        </div>
        {!isTerminal && <div className="running-row"><span className="spinner" /><div><strong>{titleCase(run.status)}</strong><span>Esure is executing this flow on Stellar Testnet.</span></div></div>}
        {reportFilter === "failed" && visibleSteps.length === 0 && visibleAssertions.length === 0 && (
          <div className="empty-checks" role="status">
            <strong>No failed checks</strong>
            <p>{run.error?.category === "timeout"
              ? "The run timed out before any step or assertion was marked as failed."
              : "No steps or assertions are currently marked as failed."}</p>
          </div>
        )}
        {run.steps.map((step, index) => (
          <div
            className="timeline-row report-row"
            key={step.id}
            id={`step-${step.id}`}
            hidden={reportFilter === "failed" && step.status !== "failed"}
          >
            <span className={`step-dot ${step.status}`}><CheckIcon /></span>
            <div>
              <span className="label">STEP {String(index + 1).padStart(2, "0")} / {step.type}</span>
              <span className="print-status-label">{titleCase(step.status)}</span>
              <strong>{humanize(step.id)}</strong><p>{step.message}</p>
              {step.transactionHash && (
                <div className="tx-actions">
                  <a href={`https://stellar.expert/explorer/testnet/tx/${step.transactionHash}`} target="_blank" rel="noreferrer">View transaction <ArrowIcon /></a>
                  <CopyButton value={step.transactionHash} label={`transaction ${step.transactionHash}`} />
                  <code className="transaction-hash print-only">{step.transactionHash}</code>
                </div>
              )}
            </div>
            {step.ledger && <code className="ledger">L#{step.ledger}</code>}
          </div>
        ))}
        {run.assertions.map((assertion, index) => (
          <AssertionRow
            key={`${assertion.type}-${index}`}
            assertion={assertion}
            hidden={reportFilter === "failed" && assertion.status !== "failed"}
          />
          <AssertionRow key={`${assertion.type}-${index}`} assertion={assertion} reportFilter={reportFilter} />
        ))}
        {run.error && (
          <div className="run-error" role="alert">
            <WarningIcon />
            <div style={{ flex: 1 }}>
              <strong>{run.error.code}</strong>
              <span>{sanitizeErrorMessage(run.error.message, run.error.category)}</span>
              <details className="error-diagnostics" open style={{ marginTop: "12px", borderTop: "1px dashed #dda395", paddingTop: "8px" }}>
                <summary style={{ cursor: "pointer", fontSize: "11px", fontWeight: "700", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                  Diagnostic details
                </summary>
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 14px", marginTop: "8px", fontSize: "12px" }}>
                  <span className="label">CATEGORY:</span>
                  <span>{ERROR_CATEGORY_LABELS[run.error.category] ?? run.error.category}</span>
                  <span className="label">RETRYABILITY:</span>
                  <span>{getRetryabilityLabel(run.error.retryable)}</span>
                  {run.error.failedStepId && (
                    <>
                      <span className="label">FAILED STEP:</span>
                      <span>
                        <a href={`#step-${run.error.failedStepId}`} style={{ color: "var(--deep)", fontWeight: 600 }}>
                          {humanize(run.error.failedStepId)}
                        </a>
                      </span>
                    </>
                  )}
                  {run.error.stellarTransactionCode && (
                    <>
                      <span className="label">TX CODE:</span>
                      <code>{run.error.stellarTransactionCode}</code>
                    </>
                  )}
                  {run.error.stellarOperationCodes && run.error.stellarOperationCodes.length > 0 && (
                    <>
                      <span className="label">OP CODES:</span>
                      <code>{run.error.stellarOperationCodes.join(", ")}</code>
                    </>
                  )}
                </div>
              </details>
            </div>
          </div>
        )}
      </div>
      <aside className="summary-card">
        <p className="eyebrow">RUN SUMMARY</p>
        <div className="score"><strong>{run.summary.stepsPassed + run.summary.assertionsPassed}</strong><span>checks passed</span></div>
        <dl><div><dt>Steps passed</dt><dd>{run.summary.stepsPassed}</dd></div><div><dt>Steps failed</dt><dd>{run.summary.stepsFailed}</dd></div><div><dt>Assertions passed</dt><dd>{run.summary.assertionsPassed}</dd></div><div><dt>Assertions failed</dt><dd>{run.summary.assertionsFailed}</dd></div></dl>
        {isTerminal && (
          <>
            <button
              type="button"
              className="download"
              disabled={downloading}
              aria-busy={downloading}
              onClick={handleDownload}
            >
              <span>{downloading ? "Downloading report…" : "Download JSON report"}</span>
              <DownloadIcon />
            </button>
            {downloadError && (
              <p className="download-error" role="alert" data-testid="download-error">
                {downloadError}
              </p>
            )}
          </>
        )}
      </aside>
    </div>
  );
}

function ReportComparisonView({ currentRun }: { currentRun: RunReport | null }) {
  const [reportA, setReportA] = useState<RunReport | null>(null);
  const [reportB, setReportB] = useState<RunReport | null>(null);
  const [errorA, setErrorA] = useState<string | null>(null);
  const [errorB, setErrorB] = useState<string | null>(null);

  async function handleFileA(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    if (file.size > MAX_REPORT_FILE_BYTES) {
      setErrorA(`File is too large (${(file.size / (1024 * 1024)).toFixed(1)}MB). Maximum allowed size is 5MB.`);
      return;
    }
    try {
      const text = await file.text();
      setReportA(parseReportJson(text, MAX_REPORT_FILE_BYTES));
      setErrorA(null);
    } catch (err) {
      setErrorA(err instanceof Error ? err.message : "Failed to parse Report A.");
    }
  }

  async function handleFileB(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    if (file.size > MAX_REPORT_FILE_BYTES) {
      setErrorB(`File is too large (${(file.size / (1024 * 1024)).toFixed(1)}MB). Maximum allowed size is 5MB.`);
      return;
    }
    try {
      const text = await file.text();
      setReportB(parseReportJson(text, MAX_REPORT_FILE_BYTES));
      setErrorB(null);
    } catch (err) {
      setErrorB(err instanceof Error ? err.message : "Failed to parse Report B.");
    }
  }

  const comparison = useMemo(() => {
    if (!reportA || !reportB) return null;
    return compareReports(reportA, reportB);
  }, [reportA, reportB]);

  return (
    <div className="comparison-container">
      <div className="comparison-inputs" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "16px", marginBottom: "20px" }}>
        <div className="comparison-input-card" style={{ border: "1px solid var(--line)", padding: "16px", background: "#f8f6f0" }}>
          <span className="label">REPORT A (BASE)</span>
          <div style={{ margin: "10px 0", display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <label className="run-button run-button--secondary" style={{ padding: "8px 14px", minWidth: "auto", cursor: "pointer", display: "inline-block" }}>
              Choose Report A JSON
              <input type="file" accept=".json,application/json" data-testid="compare-file-a" onChange={handleFileA} style={{ display: "none" }} />
            </label>
            {currentRun && (
              <button
                type="button"
                className="run-button run-button--secondary"
                style={{ padding: "8px 14px", minWidth: "auto" }}
                onClick={() => { setReportA(currentRun); setErrorA(null); }}
              >
                Use current run
              </button>
            )}
          </div>
          {errorA && <div className="error-banner" role="alert" style={{ margin: "8px 0" }}><span>{errorA}</span></div>}
          {reportA && (
            <div style={{ fontSize: "12px", color: "var(--muted)" }}>
              Loaded: <code>{reportA.id}</code> ({reportA.scenarioId} v{reportA.scenarioVersion}) - <strong>{titleCase(reportA.status)}</strong>
            </div>
          )}
        </div>

        <div className="comparison-input-card" style={{ border: "1px solid var(--line)", padding: "16px", background: "#f8f6f0" }}>
          <span className="label">REPORT B (COMPARISON)</span>
          <div style={{ margin: "10px 0", display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <label className="run-button run-button--secondary" style={{ padding: "8px 14px", minWidth: "auto", cursor: "pointer", display: "inline-block" }}>
              Choose Report B JSON
              <input type="file" accept=".json,application/json" data-testid="compare-file-b" onChange={handleFileB} style={{ display: "none" }} />
            </label>
            {currentRun && (
              <button
                type="button"
                className="run-button run-button--secondary"
                style={{ padding: "8px 14px", minWidth: "auto" }}
                onClick={() => { setReportB(currentRun); setErrorB(null); }}
              >
                Use current run
              </button>
            )}
          </div>
          {errorB && <div className="error-banner" role="alert" style={{ margin: "8px 0" }}><span>{errorB}</span></div>}
          {reportB && (
            <div style={{ fontSize: "12px", color: "var(--muted)" }}>
              Loaded: <code>{reportB.id}</code> ({reportB.scenarioId} v{reportB.scenarioVersion}) - <strong>{titleCase(reportB.status)}</strong>
            </div>
          )}
        </div>
      </div>

      {!reportA || !reportB ? (
        <div className="empty-report">
          <strong>Select two reports to compare</strong>
          <p>Upload two JSON export files to view differences in execution duration, step outcomes, and assertions.</p>
        </div>
      ) : comparison ? (
        <div className="comparison-results">
          {!comparison.scenariosMatch && (
            <div className="warning-banner" role="alert" style={{ background: "#fef3c7", border: "1px solid #f59e0b", padding: "16px", marginBottom: "16px" }}>
              <strong style={{ color: "#92400e" }}>Warning: Different scenario content</strong>
              <p style={{ margin: "4px 0 0", color: "#92400e", fontSize: "13px" }}>
                These reports describe different scenario content ({!comparison.scenarioIdMatch ? "scenario ID mismatch; " : ""}{!comparison.versionMatch ? "version mismatch; " : ""}{!comparison.contentHashMatch ? "content hash mismatch" : ""}). Outcome differences may be due to scenario specification changes rather than execution behavior, and no claim of causality is made.
              </p>
            </div>
          )}

          <div className="timeline-card" style={{ marginBottom: "16px" }}>
            <div className="report-meta">
              <span>SCENARIO</span>
              <code>{reportA.scenarioId} (v{reportA.scenarioVersion}) vs {reportB.scenarioId} (v{reportB.scenarioVersion})</code>
              <span>STATUS</span>
              <code>{titleCase(reportA.status)} → {titleCase(reportB.status)} {comparison.statusChanged ? "(changed)" : "(same)"}</code>
              <span>DURATION</span>
              <code>
                {comparison.durationMsA !== null ? `${(comparison.durationMsA / 1000).toFixed(1)}s` : "N/A"} → {comparison.durationMsB !== null ? `${(comparison.durationMsB / 1000).toFixed(1)}s` : "N/A"}
                {comparison.durationDiffMs !== null ? ` (diff: ${comparison.durationDiffMs >= 0 ? "+" : ""}${(comparison.durationDiffMs / 1000).toFixed(1)}s)` : ""}
              </code>
            </div>

            <div style={{ padding: "16px 24px", borderBottom: "1px solid var(--line)" }}>
              <span className="label">SUMMARY DIFF</span>
              <p style={{ margin: "6px 0 0", fontSize: "13px" }}>
                Steps: {comparison.summary.stepsUnchanged} unchanged, {comparison.summary.stepsChanged} changed, {comparison.summary.stepsAdded} added, {comparison.summary.stepsRemoved} removed.
                <br />
                Assertions: {comparison.summary.assertionsUnchanged} unchanged, {comparison.summary.assertionsChanged} changed, {comparison.summary.assertionsAdded} added, {comparison.summary.assertionsRemoved} removed.
              </p>
            </div>

            <div style={{ padding: "12px 24px" }}>
              <span className="label">STEP DIFFERENCES ({comparison.steps.length})</span>
            </div>
            {comparison.steps.map((s) => (
              <div key={s.id} className="timeline-row report-row">
                <span className={`step-dot ${s.statusB || s.statusA || "failed"}`}><CheckIcon /></span>
                <div>
                  <span className="label">{s.type} / {s.statusChange.toUpperCase()}</span>
                  <strong>{humanize(s.id)}</strong>
                  <p>
                    Report A: <code>{s.statusA ?? "none"}</code> | Report B: <code>{s.statusB ?? "none"}</code>
                  </p>
                </div>
              </div>
            ))}

            <div style={{ padding: "12px 24px", borderTop: "1px solid var(--line)" }}>
              <span className="label">ASSERTION DIFFERENCES ({comparison.assertions.length})</span>
            </div>
            {comparison.assertions.map((a) => (
              <div key={a.key} className="assertion report-row">
                <span className={`step-dot ${a.statusB || a.statusA || "failed"}`}><CheckIcon /></span>
                <div>
                  <span className="label">{a.key} / {a.statusChange.toUpperCase()}</span>
                  <strong>{a.type}</strong>
                  <p style={{ margin: "4px 0 0", fontSize: "12px", color: "var(--muted)" }}>
                    Report A: <code>{a.statusA ?? "none"}</code> | Report B: <code>{a.statusB ?? "none"}</code>
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
// #34 — Expandable assertion row with expected / actual values
function AssertionRow({ assertion, hidden }: { assertion: import("@/lib/api").AssertionResult; hidden?: boolean }) {
function AssertionRow({ assertion, reportFilter }: { assertion: import("@/lib/api").AssertionResult; reportFilter?: ReportFilter }) {
  const [expanded, setExpanded] = useState(false);
  const hasDiff = assertion.expected !== undefined || assertion.actual !== undefined;
  const isFailed = assertion.status === "failed";

  return (
    <div className={`assertion report-row ${isFailed && hasDiff ? "assertion--has-diff" : ""}`} hidden={hidden}>
    <div className={`assertion report-row ${isFailed && hasDiff ? "assertion--has-diff" : ""}`} hidden={reportFilter === "failed" && assertion.status !== "failed"}>
      <span className={`step-dot ${assertion.status}`}><CheckIcon /></span>
      <div className="assertion-body">
        <span className="label">ASSERTION / {assertion.type}</span>
        <span className="print-status-label">{titleCase(assertion.status)}</span>
        <strong>{assertion.message}</strong>
        {hasDiff && (
          <div className="assertion-diff-toggle">
            <button
              type="button"
              className="diff-toggle-btn"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Hide details" : "Show details"}
              <ChevronIcon rotated={expanded} />
            </button>
            {expanded && (
              <div className="assertion-diff" role="region" aria-label="Assertion details">
                <AssertionValue label="Expected" value={assertion.expected} />
                <AssertionValue label="Actual" value={assertion.actual} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const MAX_INLINE_LENGTH = 120;

function AssertionValue({ label, value }: { label: string; value: JsonValue }) {
  const [expanded, setExpanded] = useState(false);
  const serialized = serializeJsonValue(value);
  const isLong = serialized.length > MAX_INLINE_LENGTH;
  const displayText = isLong && !expanded ? serialized.slice(0, MAX_INLINE_LENGTH) + "…" : serialized;

  return (
    <div className="assertion-value">
      <span className="assertion-value-label">{label}</span>
      <pre className="assertion-value-pre">{displayText}</pre>
      {isLong && (
        <button
          type="button"
          className="diff-toggle-btn diff-toggle-btn--small"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? "Show less" : "Show full value"}
        </button>
      )}
    </div>
  );
}

/** Serialise a JsonValue to a human-readable string preserving decimal-string precision. */
function serializeJsonValue(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  // array / object — JSON.stringify with indentation; values are already JS primitives
  // so no precision is lost compared to Number coercion
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function EmptyReport() {
  return <div className="empty-report"><div className="empty-glyph"><span /><span /><span /></div><strong>No run yet</strong><p>Select a scenario and run it to see each Stellar operation appear here.</p></div>;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch {
      setStatus("error");
    }
  }

  return (
    <span className="copy-control">
      <button type="button" className="copy-button" onClick={copy} aria-label={`Copy ${label}`}>
        {status === "copied" ? "Copied" : "Copy"}
      </button>
      {status === "copied" && <span role="status" className="copy-status">Copied {label}</span>}
      {status === "error" && <span role="status" className="copy-error">Could not copy {label}</span>}
    </span>
  );
}

function StatusBadge({ status }: { status: RunReport["status"] }) {
  return <span className={`status-badge ${status}`}><span />{titleCase(status)}</span>;
}

function ScenarioIcon({ kind }: { kind: string }) {
  if (kind === "xlm-payment") return <svg className="scenario-icon" viewBox="0 0 40 40" fill="none"><circle cx="20" cy="20" r="13"/><path d="m13 24 16-9M12 19l16-9M14 30l14-8"/></svg>;
  if (kind === "issued-asset-payment") return <svg className="scenario-icon" viewBox="0 0 40 40" fill="none"><rect x="7" y="10" width="20" height="20" rx="3"/><path d="M13 16h8M13 21h8M13 26h5M30 15v12M26 23l4 4 4-4"/></svg>;
  return <svg className="scenario-icon" viewBox="0 0 40 40" fill="none"><path d="M20 6 35 33H5L20 6Z"/><path d="M20 15v9M20 28v1"/></svg>;
}

function PlayIcon() { return <svg viewBox="0 0 20 20" fill="none"><path d="m7 5 7 5-7 5V5Z"/></svg>; }
function ArrowIcon() { return <svg viewBox="0 0 16 16" fill="none"><path d="M3 13 13 3M6 3h7v7"/></svg>; }
function DownloadIcon() { return <svg viewBox="0 0 20 20" fill="none"><path d="M10 3v10M6 9l4 4 4-4M4 17h12"/></svg>; }
function CheckIcon() { return <svg viewBox="0 0 16 16" fill="none"><path d="m3 8 3 3 7-7"/></svg>; }
function WarningIcon() { return <svg viewBox="0 0 20 20" fill="none"><path d="M10 3 18 17H2L10 3ZM10 8v4M10 15v.1"/></svg>; }
function SearchIcon() { return <svg className="search-icon" viewBox="0 0 20 20" fill="none"><circle cx="8.5" cy="8.5" r="5"/><path d="m12.5 12.5 4 4"/></svg>; }
function ChevronIcon({ rotated }: { rotated?: boolean } = {}) {
  return (
    <svg
      className={`chevron-icon${rotated ? " chevron-icon--up" : ""}`}
      viewBox="0 0 16 16"
      fill="none"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function readError(reason: unknown): string {
  if (reason instanceof ApiError) return `${reason.message} (${reason.code})`;
  if (reason instanceof Error) return reason.message;
  return "An unexpected error occurred.";
}

function humanize(value: string): string { return value.split("-").map(titleCase).join(" "); }
function titleCase(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }

function formatLocaleDateTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function formatElapsed(startIso: string, nowMs: number): string {
  const start = new Date(startIso).getTime();
  if (!Number.isFinite(start) || start > nowMs) return "0s";
  const seconds = Math.max(0, Math.floor((nowMs - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export function computeDuration(startIso: string, endIso: string): string {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return "0s";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}
