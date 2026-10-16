"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { ApiError, getRun, listScenarios, startRun, type RunReport, type ScenarioSummary } from "@/lib/api";

const terminalStatuses = new Set(["passed", "failed"]);

export type ScenarioFilter = "all" | "xlm" | "issued-asset" | "expected-failure";

export const FILTER_OPTIONS: { key: ScenarioFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "xlm", label: "XLM" },
  { key: "issued-asset", label: "Issued Asset" },
  { key: "expected-failure", label: "Expected Failure" },
];

type ReportFilter = "all" | "failed";

const REPORT_FILTER_OPTIONS: { key: ReportFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "failed", label: "Failed" },
];

export function filterScenario(scenario: ScenarioSummary, filter: ScenarioFilter): boolean {
  if (filter === "all") return true;
  const text = `${scenario.id} ${scenario.name} ${scenario.description}`.toLowerCase();
  if (filter === "xlm") return text.includes("xlm");
  if (filter === "issued-asset") return text.includes("issued") || text.includes("testusd") || scenario.id === "issued-asset-payment";
  if (filter === "expected-failure") return text.includes("fail") || text.includes("missing-trustline") || scenario.id === "missing-trustline";
  return true;
}

export function Dashboard() {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [filter, setFilter] = useState<ScenarioFilter>("all");
  const [reportFilter, setReportFilter] = useState<ReportFilter>("all");
  const [selectedId, setSelectedId] = useState<string>("");
  const [run, setRun] = useState<RunReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  const [pollingError, setPollingError] = useState<string | null>(null);
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const runIdParam = searchParams?.get("runId");

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

  const filteredScenarios = useMemo(() => {
    return scenarios.filter((s) => filterScenario(s, filter));
  }, [scenarios, filter]);

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
    if (!run || terminalStatuses.has(run.status)) return;
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
  }, [run, consecutiveFailures]);

  const selected = useMemo(() => scenarios.find((scenario) => scenario.id === selectedId), [scenarios, selectedId]);

  async function handleRun() {
    if (!selectedId) return;
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
      setError(readError(reason));
    } finally {
      setStarting(false);
    }
  }

  return (
    <main>
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

      <section className="workspace shell">
        <div className="section-heading">
          <div><p className="eyebrow">01 / CHOOSE A FLOW</p><h2>Test scenarios</h2></div>
          <span className="scenario-count">{filteredScenarios.length.toString().padStart(2, "0")} AVAILABLE</span>
        </div>

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
              <p>No scenarios match the selected filter (&quot;{FILTER_OPTIONS.find((o) => o.key === filter)?.label}&quot;).</p>
            </div>
          ) : (
            filteredScenarios.map((scenario, index) => (
              <button
                type="button"
                className={`scenario-card ${selectedId === scenario.id ? "selected" : ""}`}
                key={scenario.id}
                onClick={() => setSelectedId(scenario.id)}
              >
                <span className="card-index">0{index + 1}</span>
                <ScenarioIcon kind={scenario.id} />
                <span className="scenario-name">{scenario.name}</span>
                <span className="scenario-description">{scenario.description}</span>
                <span className="version">V{scenario.version}</span>
              </button>
            ))
          )}
        </div>

        <div className="launch-panel">
          <div><span className="label">SELECTED SCENARIO</span><strong>{selected?.name ?? "Choose a scenario"}</strong><span>{selected?.id ?? "—"}</span></div>
          <button className="run-button" type="button" disabled={!selected || starting || (!!run && !terminalStatuses.has(run.status))} onClick={handleRun}>
            {starting ? "Starting…" : run && !terminalStatuses.has(run.status) ? "Running…" : "Run on Testnet"}<PlayIcon />
          </button>
        </div>
      </section>

      <section className="results shell">
        <div className="section-heading">
          <div><p className="eyebrow">02 / INSPECT THE RUN</p><h2>Execution report</h2></div>
          {run && (
            <div className="report-controls">
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
            </div>
          )}
        </div>
        {!run ? (
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
  const pending = !terminalStatuses.has(run.status);
  const createdLabel = formatLocaleDateTime(run.createdAt);
  const completedLabel = run.completedAt ? formatLocaleDateTime(run.completedAt) : null;
  const durationLabel = run.completedAt ? computeDuration(run.createdAt, run.completedAt) : null;
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
          {durationLabel ? <><span>DURATION</span><code>{durationLabel}</code></> : null}
        </div>
        {pending && <div className="running-row"><span className="spinner" /><div><strong>{titleCase(run.status)}</strong><span>Esure is executing this flow on Stellar Testnet.</span></div></div>}
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
          <div
            className="assertion report-row"
            key={`${assertion.type}-${index}`}
            hidden={reportFilter === "failed" && assertion.status !== "failed"}
          >
            <span className={`step-dot ${assertion.status}`}><CheckIcon /></span>
            <div><span className="label">ASSERTION / {assertion.type}</span><span className="print-status-label">{titleCase(assertion.status)}</span><strong>{assertion.message}</strong></div>
          </div>
        ))}
        {run.error && <div className="run-error"><WarningIcon /><div><strong>{run.error.code}</strong><span>{run.error.message}</span></div></div>}
      </div>
      <aside className="summary-card">
        <p className="eyebrow">RUN SUMMARY</p>
        <div className="score"><strong>{run.summary.stepsPassed + run.summary.assertionsPassed}</strong><span>checks passed</span></div>
        <dl><div><dt>Steps passed</dt><dd>{run.summary.stepsPassed}</dd></div><div><dt>Steps failed</dt><dd>{run.summary.stepsFailed}</dd></div><div><dt>Assertions passed</dt><dd>{run.summary.assertionsPassed}</dd></div><div><dt>Assertions failed</dt><dd>{run.summary.assertionsFailed}</dd></div></dl>
        {terminalStatuses.has(run.status) && <a className="download" href={`/api/backend/api/v1/runs/${run.id}/report`} download>Download JSON report <DownloadIcon /></a>}
      </aside>
    </div>
  );
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

function computeDuration(startIso: string, endIso: string): string {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}
