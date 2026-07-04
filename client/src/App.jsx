import { useEffect, useMemo, useState } from "react";

const apiBase = "http://localhost:3000";

const initialRequest = {
  capability: "PAN_VERIFICATION",
  payload: {
    pan: "ABCDE1234F",
    name: "Rahul Sharma"
  },
  requirements: {
    maxLatencyMs: 2000,
    preferLowCost: true
  }
};

function Section({ title, eyebrow, children }) {
  return (
    <section className="panel">
      <div className="panel__header">
        <span>{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function normalizeText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function prettyVendorName(value) {
  return normalizeText(value).replace(/^vendor\s*/i, "Vendor ");
}

function recommendStrategyFromText(text) {
  const value = normalizeText(text).toLowerCase();

  // Traffic splits / percentage allocations always imply weighted routing
  if (value.includes("traffic") || value.includes("%") || value.includes("weighted") || value.includes("percent")) {
    return { strategy: "weighted", reason: "The request includes traffic splits, which maps naturally to weighted routing." };
  }

  if (value.includes("round robin")) {
    return { strategy: "round-robin", reason: "The request explicitly mentions round-robin traffic rotation." };
  }

  if (value.includes("priority")) {
    return { strategy: "priority", reason: "The request emphasizes vendor ordering and fallback priority." };
  }

  if (value.includes("cost") || value.includes("cheap")) {
    return { strategy: "lowest-cost", reason: "The request focuses on minimizing cost." };
  }

  if (value.includes("latency") || value.includes("fastest") || value.includes("quickest")) {
    return { strategy: "lowest-latency", reason: "The request focuses on response time and latency thresholds." };
  }

  if (value.includes("switch to") || value.includes("fallback") || value.includes("error rate") || value.includes("down")) {
    return { strategy: "failover", reason: "The request describes fallback behavior when a vendor becomes unhealthy." };
  }

  if (value.includes("feature")) {
    return { strategy: "feature-based", reason: "The request mentions feature support as a selection condition." };
  }

  if (value.includes("health")) {
    return { strategy: "health-based", reason: "The request is centered on health and stability signals." };
  }

  return { strategy: "weighted", reason: "Weighted routing is the safest default when the text does not strongly favor another strategy." };
}

function detectUnhealthyVendors(currentVendors) {
  return currentVendors
    .map((vendor) => {
      const reasons = [];

      if ((vendor.status ?? vendor.healthStatus ?? "UP") !== "UP") {
        reasons.push("status is DOWN");
      }

      if (typeof vendor.errorRate === "number" && vendor.errorRate > 5) {
        reasons.push(`error rate ${Math.round(vendor.errorRate)}% is above 5%`);
      }

      if (typeof vendor.successRate === "number" && vendor.successRate < 90 && vendor.metrics?.requestCount > 0) {
        reasons.push(`success rate ${Math.round(vendor.successRate)}% is below 90%`);
      }

      if (typeof vendor.averageLatencyMs === "number" && typeof vendor.timeoutMs === "number" && vendor.averageLatencyMs > vendor.timeoutMs) {
        reasons.push(`average latency ${Math.round(vendor.averageLatencyMs)}ms exceeds timeout ${vendor.timeoutMs}ms`);
      }

      if (typeof vendor.rateLimitRemaining === "number" && vendor.rateLimitRemaining === 0) {
        reasons.push("rate limit exhausted");
      }

      return reasons.length ? { name: vendor.name, reasons } : null;
    })
    .filter(Boolean);
}

function parseRoutingConfig(text) {
  const normalized = normalizeText(text);
  const allocationRegex = /Vendor\s*([A-Za-z0-9_-]+)\s*(?:for|:)\s*(\d+)%/gi;
  const allocations = [];
  let match = allocationRegex.exec(normalized);

  while (match) {
    allocations.push({
      vendor: prettyVendorName(match[1]),
      trafficPercent: Number(match[2])
    });
    match = allocationRegex.exec(normalized);
  }

  const fallbackVendorMatch = normalized.match(/switch to Vendor\s*([A-Za-z0-9_-]+)/i);
  const latencyMatch = normalized.match(/latency crosses\s*([0-9.]+)\s*(seconds?|sec|s|milliseconds?|ms)/i);
  const errorRateMatch = normalized.match(/error rate is above\s*(\d+)%/i);

  const latencyValue = latencyMatch ? Number(latencyMatch[1]) : null;
  const latencyUnit = latencyMatch ? latencyMatch[2].toLowerCase() : null;

  const fallback = {
    vendor: fallbackVendorMatch ? prettyVendorName(fallbackVendorMatch[1]) : null,
    when: {
      latencyMs: latencyValue === null ? null : latencyUnit?.startsWith("s") && !latencyUnit.includes("ms") ? Math.round(latencyValue * 1000) : Math.round(latencyValue),
      errorRateThreshold: errorRateMatch ? Number(errorRateMatch[1]) : null
    }
  };

  return {
    allocations,
    fallback,
    parsedText: normalized
  };
}

function buildBonusAnalysis(text, currentVendors, currentMetrics, latestResult) {
  const recommendation = recommendStrategyFromText(text);
  const unhealthyVendors = detectUnhealthyVendors(currentMetrics.map((item) => ({ ...item, metrics: item.metrics })));
  const config = parseRoutingConfig(text);

  return {
    recommendedStrategy: recommendation.strategy,
    recommendationReason: recommendation.reason,
    unhealthyVendors,
    generatedConfig: {
      strategy: recommendation.strategy,
      vendors: currentVendors.map((vendor) => ({
        name: vendor.name,
        capability: vendor.capability,
        weight: vendor.weight,
        priority: vendor.priority,
        costPerRequest: vendor.costPerRequest,
        timeoutMs: vendor.timeoutMs,
        rateLimitPerMinute: vendor.rateLimitPerMinute,
        supportedFeatures: vendor.supportedFeatures
      })),
      parsedRules: config,
      fallbackRules: config.fallback.vendor
        ? [`Switch to ${config.fallback.vendor} when the primary vendor crosses the parsed threshold conditions.`]
        : ["Use the parsed fallback thresholds to move traffic to a healthier vendor."]
    },
    explanation: latestResult?.routingReason || "Run the Agentic request to see the routing decision.",
    plainEnglishSummary: text.trim() || "No routing instruction provided."
  };
}

const NUMERIC_VENDOR_FIELDS = ["weight", "priority", "costPerRequest", "rateLimitPerMinute", "timeoutMs", "baseLatencyMs"];

function coerceVendorForm(form) {
  const out = { ...form };
  for (const field of NUMERIC_VENDOR_FIELDS) {
    if (out[field] !== undefined && out[field] !== "") {
      const n = Number(out[field]);
      if (!Number.isNaN(n)) out[field] = n;
    }
  }
  return out;
}

export default function App() {
  const [activeView, setActiveView] = useState("client");
  const [vendors, setVendors] = useState([]);
  const [metrics, setMetrics] = useState([]);
  const [routingLogs, setRoutingLogs] = useState([]);
  const [requestLogs, setRequestLogs] = useState([]);
  const [health, setHealth] = useState(null);
  const [result, setResult] = useState(null);
  const [agenticResult, setAgenticResult] = useState(null);
  const [status, setStatus] = useState("Loading dashboard...");
  const [vendorMessage, setVendorMessage] = useState("");
  const [showAllRoutingLogs, setShowAllRoutingLogs] = useState(false);
  const [showAllRequestLogs, setShowAllRequestLogs] = useState(false);
  const [bonusPrompt, setBonusPrompt] = useState(
    "Use Vendor A for 70% traffic, Vendor B for 30%, but switch to Vendor C if latency crosses 2 seconds or error rate is above 5%."
  );
  const [requestBody, setRequestBody] = useState(JSON.stringify(initialRequest, null, 2));
  const [vendorForm, setVendorForm] = useState({
    name: "VendorD",
    capability: "PAN_VERIFICATION",
    weight: 60,
    costPerRequest: 1.3,
    timeoutMs: 2500,
    rateLimitPerMinute: 75,
    priority: 2,
    supportedFeatures: "name-match,pan-status",
    strategy: "weighted",
    baseLatencyMs: 950
  });

  const loadData = async () => {
    setStatus("Refreshing vendor data...");
    const [vendorResponse, metricResponse, healthResponse, routingLogsResponse, requestLogsResponse] = await Promise.all([
      fetch(`${apiBase}/vendors`),
      fetch(`${apiBase}/vendor-metrics`),
      fetch(`${apiBase}/health`),
      fetch(`${apiBase}/routing-logs`),
      fetch(`${apiBase}/request-logs`)
    ]);

    const vendorData = await vendorResponse.json();
    const metricData = await metricResponse.json();
    const healthData = await healthResponse.json();
    const routingLogsData = await routingLogsResponse.json();
    const requestLogsData = await requestLogsResponse.json();

    setVendors(vendorData.vendors ?? []);
    setMetrics(metricData.metrics ?? []);
    setHealth(healthData);
    setRoutingLogs(routingLogsData.logs ?? []);
    setRequestLogs(requestLogsData.logs ?? []);
    setStatus("Live demo connected to the backend");
  };

  useEffect(() => {
    loadData().catch(() => setStatus("Backend is not reachable. Start the server first."));
  }, []);

  const summary = useMemo(
    () => ({
      vendors: vendors.length,
      successRate: metrics.length ? Math.round(metrics.reduce((total, item) => total + item.successRate, 0) / metrics.length) : 0,
      avgLatency: metrics.length ? Math.round(metrics.reduce((total, item) => total + item.averageLatencyMs, 0) / metrics.length) : 0
    }),
    [vendors.length, metrics]
  );

  const bonusAnalysis = useMemo(() => buildBonusAnalysis(bonusPrompt, vendors, metrics, agenticResult), [bonusPrompt, vendors, metrics, agenticResult]);

  const routingConfigSummary = useMemo(() => {
    const allocations = bonusAnalysis.generatedConfig.parsedRules.allocations;
    const fallbackVendor = bonusAnalysis.generatedConfig.parsedRules.fallback.vendor;
    const fallbackLatency = bonusAnalysis.generatedConfig.parsedRules.fallback.when.latencyMs;
    const fallbackErrorRate = bonusAnalysis.generatedConfig.parsedRules.fallback.when.errorRateThreshold;

    const allocationText = allocations.length
      ? allocations.map((item) => `${item.vendor} ${item.trafficPercent}%`).join(", ")
      : "No explicit traffic splits were detected.";

    const fallbackParts = [];
    if (fallbackVendor) {
      fallbackParts.push(`switch to ${fallbackVendor}`);
    }
    if (fallbackLatency !== null) {
      fallbackParts.push(`latency > ${fallbackLatency} ms`);
    }
    if (fallbackErrorRate !== null) {
      fallbackParts.push(`error rate > ${fallbackErrorRate}%`);
    }

    const fallbackText = fallbackParts.length
      ? `Fallback rule: ${fallbackParts.join(" or ")}.`
      : "Fallback rule: use the parsed healthy-vendor thresholds.";

    return `${allocationText} ${fallbackText}`;
  }, [bonusAnalysis]);

  const addVendor = async () => {
    setVendorMessage("");
    const payload = coerceVendorForm({
      ...vendorForm,
      supportedFeatures: String(vendorForm.supportedFeatures)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    });

    const response = await fetch(`${apiBase}/vendors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
      setVendorMessage(data.error || "Failed to add vendor");
      return;
    }

    setVendorMessage(`Added ${data.vendor?.name ?? "vendor"}`);
    await loadData();
  };

  const removeVendor = async (vendorId, vendorName) => {
    if (!window.confirm(`Delete ${vendorName}?`)) return;
    await fetch(`${apiBase}/vendors/${vendorId}`, { method: "DELETE" });
    await loadData();
  };

  const toggleVendorStatus = async (vendorId, currentStatus) => {
    const nextStatus = currentStatus === "UP" ? "DOWN" : "UP";

    await fetch(`${apiBase}/vendors/${vendorId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus })
    });

    await loadData();
  };

  const applyAndRunAgentic = async () => {
    try {
      const payload = {
        capability: "PAN_VERIFICATION",
        payload: {
          pan: "ABCDE1234F",
          name: "Rahul Sharma"
        },
        requirements: {
          strategy: bonusAnalysis.recommendedStrategy
        }
      };

      const allocations = bonusAnalysis.generatedConfig.parsedRules.allocations;
      if (allocations.length > 0) {
        payload.requirements.weights = {};
        for (const alloc of allocations) {
          const dbName = alloc.vendor.replace(/\s+/g, "");
          payload.requirements.weights[dbName] = alloc.trafficPercent;
        }
      }

      const latency = bonusAnalysis.generatedConfig.parsedRules.fallback.when.latencyMs;
      if (latency !== null) {
        payload.requirements.maxLatencyMs = latency;
      }

      const errorRate = bonusAnalysis.generatedConfig.parsedRules.fallback.when.errorRateThreshold;
      if (errorRate !== null) {
        payload.requirements.maxErrorRate = errorRate;
      }

      // Sync the request body JSON textarea in the UI
      setRequestBody(JSON.stringify(payload, null, 2));

      setStatus("Sending agentic request to routing engine...");
      const response = await fetch(`${apiBase}/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      setAgenticResult(data);
      await loadData();
    } catch (error) {
      setAgenticResult({ status: "FAILED", routingReason: error.message });
    }
  };

  const submitRoute = async () => {
    try {
      const parsed = JSON.parse(requestBody);
      const response = await fetch(`${apiBase}/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed)
      });
      const data = await response.json();
      setResult(data);
      await loadData();
    } catch (error) {
      setResult({ status: "FAILED", routingReason: error.message });
    }
  };


  return (
    <div className="shell">
      <div className="hero">
        <div>
          <p className="eyebrow">Client Portal</p>
          <h1>Intelligent Vendor Routing Platform</h1>
          <p className="hero__copy">
            Unified API gateway that automatically routes requests to the best vendor based on cost, latency, and health.
          </p>
        </div>
        <div className="hero__status">
          <span>{status}</span>
          <button onClick={loadData}>Refresh</button>
        </div>
      </div>

      <div className="view-switch">
        <button className={activeView === "client" ? "view-switch__button view-switch__button--active" : "view-switch__button"} onClick={() => setActiveView("client")}>
          Client Portal
        </button>
        <button className={activeView === "admin" ? "view-switch__button view-switch__button--active" : "view-switch__button"} onClick={() => setActiveView("admin")}>
          Admin Dashboard
        </button>
      </div>

      {activeView === "client" ? (
        <>
          <div className="client-layout">
            <Section title="Route request" eyebrow="POST /route">
              <textarea value={requestBody} onChange={(event) => setRequestBody(event.target.value)} spellCheck="false" />
              <div className="actions actions--left">
                <button onClick={submitRoute}>Send request</button>
              </div>
              {result ? <pre className="codebox codebox--compact">{JSON.stringify(result, null, 2)}</pre> : null}
            </Section>

            <Section title="Background processing" eyebrow="SYSTEM">
              <div className="bonus-card">
                <strong>What happens behind the scenes</strong>
                <p>
                  The router compares eligible vendors, applies the selected strategy, runs failover if needed, and returns only the final matched response to the client.
                </p>
              </div>
              <div className="bonus-card">
                <strong>Current health snapshot</strong>
                <p>
                  Active vendors: {summary.vendors}. Average success: {summary.successRate}%. Average latency: {summary.avgLatency} ms.
                </p>
              </div>
            </Section>
          </div>

          <Section title="Bonus: Agentic AI" eyebrow="AI BONUS">
            <div className="bonus-grid">
              <div className="bonus-block">
                <span className="bonus-label">Plain English routing config</span>
                <textarea value={bonusPrompt} onChange={(event) => setBonusPrompt(event.target.value)} spellCheck="false" />
                <p className="bonus-copy">The panel below recommends a strategy, detects unhealthy vendors from live metrics, and turns plain English into routing rules.</p>
                <div className="actions actions--left" style={{ marginTop: "12px" }}>
                  <button onClick={applyAndRunAgentic}>Apply & Route Request</button>
                </div>
              </div>

              <div className="bonus-results">
                <div className="bonus-chip-row">
                  <span className="bonus-chip">Strategy: {bonusAnalysis.recommendedStrategy}</span>
                  <span className="bonus-chip">Healthy check: {bonusAnalysis.unhealthyVendors.length ? `${bonusAnalysis.unhealthyVendors.length} flagged` : "all clear"}</span>
                </div>

                <div className="bonus-card">
                  <strong>Parsed routing config</strong>
                  <p>{routingConfigSummary}</p>
                </div>

                <pre className="codebox codebox--compact codebox--bonus">{JSON.stringify(bonusAnalysis.generatedConfig, null, 2)}</pre>

                <div className="bonus-card">
                  <strong>Why this strategy</strong>
                  <p>{bonusAnalysis.recommendationReason}</p>
                </div>

                <div className="bonus-card">
                  <strong>Why a vendor was selected</strong>
                  <p>{bonusAnalysis.explanation}</p>
                </div>

                {agenticResult ? (
                  <div className="bonus-card">
                    <strong>Routing result</strong>
                    <pre className="codebox codebox--compact">{JSON.stringify(agenticResult, null, 2)}</pre>
                  </div>
                ) : null}

                <div className="bonus-card">
                  <strong>Unhealthy vendors</strong>
                  {bonusAnalysis.unhealthyVendors.length ? (
                    <ul className="bonus-list">
                      {bonusAnalysis.unhealthyVendors.map((vendor) => (
                        <li key={vendor.name}>
                          <span>{vendor.name}</span>
                          <span>{vendor.reasons.join("; ")}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No unhealthy vendors detected from the current metrics.</p>
                  )}
                </div>
              </div>
            </div>
          </Section>
        </>
      ) : (
        <div className="admin-layout">
          <Section title="System health" eyebrow="GET /health">
            <div className="endpoint-grid">
              <div className="bonus-card">
                <strong>Status</strong>
                <p>{health?.status ?? "-"}</p>
              </div>
              <div className="bonus-card">
                <strong>Service</strong>
                <p>{health?.service ?? "-"}</p>
              </div>
              <div className="bonus-card">
                <strong>Vendors</strong>
                <p>{health?.vendors ?? vendors.length}</p>
              </div>
            </div>
          </Section>

          <Section title="Vendor management" eyebrow="POST /vendors | PATCH /vendors/:id/status">
            <div className="formgrid">
              {Object.entries(vendorForm).map(([key, value]) => (
                <label key={key}>
                  <span>{key}</span>
                  <input
                    value={value}
                    onChange={(event) =>
                      setVendorForm((current) => ({
                        ...current,
                        [key]: event.target.value
                      }))
                    }
                  />
                </label>
              ))}
            </div>
            <div className="actions actions--left">
              <button onClick={addVendor}>Add vendor</button>
            </div>
            {vendorMessage ? <pre className="codebox">{vendorMessage}</pre> : null}
            <div className="cards admin-vendor-list">
              {vendors.map((vendor) => (
                <article className="card card--soft" key={vendor.id}>
                  <h3>{vendor.name}</h3>
                  <p>{vendor.capability}</p>
                  <div className="mini-grid">
                    <span>Priority {vendor.priority}</span>
                    <span>Cost ${vendor.costPerRequest}</span>
                    <span>Timeout {vendor.timeoutMs} ms</span>
                    <span>Health {vendor.status ?? vendor.healthStatus ?? "UP"}</span>
                  </div>
                  <div className="actions actions--left" style={{ gap: "8px" }}>
                    <button onClick={() => toggleVendorStatus(vendor.id, vendor.status ?? vendor.healthStatus ?? "UP")}>
                      Toggle health
                    </button>
                    <button
                      onClick={() => removeVendor(vendor.id, vendor.name)}
                      style={{ color: "#b91c1c", borderColor: "#f87171" }}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </Section>

          <Section title="Vendor metrics" eyebrow="GET /vendor-metrics">
            <div className="cards">
              {metrics.map((vendor) => (
                <article className="card" key={vendor.id}>
                  <h3>{vendor.name}</h3>
                  <p>{vendor.strategy}</p>
                  <div className="mini-grid">
                    <span>Success {Math.round(vendor.successRate)}%</span>
                    <span>Error {Math.round(vendor.errorRate)}%</span>
                    <span>Latency {Math.round(vendor.averageLatencyMs)} ms</span>
                    <span>Remaining {vendor.rateLimitRemaining}</span>
                  </div>
                </article>
              ))}
            </div>
          </Section>

          <Section title="Routing logs" eyebrow="GET /routing-logs">
            <div className="timeline">
              {(showAllRoutingLogs ? routingLogs : routingLogs.slice(0, 8)).map((entry) => (
                <article key={entry.requestId} className="timeline__item">
                  <strong>{entry.vendorUsed}</strong>
                  <span>{entry.routingReason}</span>
                </article>
              ))}
            </div>
            {routingLogs.length > 8 ? (
              <div className="actions actions--left">
                <button onClick={() => setShowAllRoutingLogs((v) => !v)}>
                  {showAllRoutingLogs ? "Show less" : `Show all ${routingLogs.length}`}
                </button>
              </div>
            ) : null}
          </Section>

          <Section title="Request logs" eyebrow="GET /request-logs">
            <div className="timeline">
              {(showAllRequestLogs ? requestLogs : requestLogs.slice(0, 8)).map((entry) => (
                <article key={entry.requestId} className="timeline__item">
                  <strong>{entry.status}</strong>
                  <span>
                    {entry.capability} {entry.vendorUsed ? `via ${entry.vendorUsed}` : ""}
                  </span>
                </article>
              ))}
            </div>
            {requestLogs.length > 8 ? (
              <div className="actions actions--left">
                <button onClick={() => setShowAllRequestLogs((v) => !v)}>
                  {showAllRequestLogs ? "Show less" : `Show all ${requestLogs.length}`}
                </button>
              </div>
            ) : null}
          </Section>
        </div>
      )}
    </div>
  );
}