import { randomUUID } from "node:crypto";
import {
  activeRequestsInLastMinute,
  appendRequestLog,
  appendRoutingLog,
  buildVendorMetricsView,
  getRoundRobinIndex,
  incrementRoundRobinCounter,
  listVendors,
  touchRateLimitWindow,
  updateVendor
} from "./store.js";

// ─── Constants ────────────────────────────────────────────────────────────────

// Vendor error rate % above which it is excluded from routing candidates.
const ERROR_RATE_DISQUALIFY_THRESHOLD = 40;

// ─── Pure scoring helpers ─────────────────────────────────────────────────────

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function normalizedScore(metricsView) {
  const latencyScore = 100 - clamp((metricsView.averageLatencyMs ?? 0) / 20, 0, 100);
  const successScore = metricsView.successRate ?? 0;
  const costScore = 100 - clamp((metricsView.costPerRequest ?? 100) / 2, 0, 100);
  const availScore = metricsView.enabled === false ? 0 : 100;
  return latencyScore * 0.4 + successScore * 0.3 + costScore * 0.2 + availScore * 0.1;
}

function getVendorScore(vendor, metricsView, request) {
  if (!metricsView) return 0;

  // Support dynamic weight overrides from request requirements (e.g., from Agentic AI)
  let weightScore = vendor.weight ?? 50;
  if (request?.requirements?.weights) {
    const override = request.requirements.weights[vendor.name];
    if (typeof override === "number") {
      weightScore = override;
    }
  }

  return normalizedScore(metricsView) + weightScore * 0.5 - (vendor.priority ?? 1) * 2;
}


// ─── Eligibility ──────────────────────────────────────────────────────────────

/**
 * Returns { ok, reason } for the vendor against this request.
 * All data is already in memory (loaded once at the start of routeRequest).
 */
function vendorMeetsRequirements(vendor, request, metricsView) {
  if (vendor.enabled === false) {
    return { ok: false, reason: "vendor is disabled" };
  }
  if ((vendor.status ?? "UP") !== "UP") {
    return { ok: false, reason: "vendor is down" };
  }
  if (vendor.capability !== request.capability) {
    return { ok: false, reason: "vendor does not support the requested capability" };
  }

  const requiredFeatures = request.requirements?.requiredFeatures ?? [];
  const supportedFeatures = vendor.supportedFeatures ?? [];
  const missingFeature = requiredFeatures.find((f) => !supportedFeatures.includes(f));
  if (missingFeature) {
    return { ok: false, reason: `missing required feature: ${missingFeature}` };
  }

  const maxLatencyMs = request.requirements?.maxLatencyMs;
  if (typeof maxLatencyMs === "number" && vendor.baseLatencyMs !== undefined && vendor.baseLatencyMs > maxLatencyMs) {
    return { ok: false, reason: "estimated latency exceeds threshold" };
  }

  if (activeRequestsInLastMinute(vendor) >= (vendor.rateLimitPerMinute ?? 100)) {
    return { ok: false, reason: "rate limit reached" };
  }

  const errorRateLimit = request.requirements?.maxErrorRate ?? ERROR_RATE_DISQUALIFY_THRESHOLD;
  if (metricsView && metricsView.metrics?.requestCount >= 5 && metricsView.errorRate > errorRateLimit) {
    return { ok: false, reason: `error rate ${metricsView.errorRate.toFixed(1)}% exceeds threshold ${errorRateLimit}%` };
  }

  return { ok: true, reason: "eligible" };
}

function getEligibilityDetails(vendor, request, metricsView) {
  const reasons = [];
  if (vendor.enabled === false) reasons.push("disabled");
  if ((vendor.status ?? "UP") !== "UP") reasons.push("down");
  if (vendor.capability !== request.capability) reasons.push("capability mismatch");

  const requiredFeatures = request.requirements?.requiredFeatures ?? [];
  const missing = requiredFeatures.filter((f) => !(vendor.supportedFeatures ?? []).includes(f));
  if (missing.length) reasons.push(`missing features: ${missing.join(", ")}`);

  const maxLatencyMs = request.requirements?.maxLatencyMs;
  if (typeof maxLatencyMs === "number" && vendor.baseLatencyMs !== undefined && vendor.baseLatencyMs > maxLatencyMs) {
    reasons.push(`latency ${vendor.baseLatencyMs}ms above threshold ${maxLatencyMs}ms`);
  }

  if (activeRequestsInLastMinute(vendor) >= (vendor.rateLimitPerMinute ?? 100)) {
    reasons.push("rate limit reached");
  }

  const errorRateLimit = request.requirements?.maxErrorRate ?? ERROR_RATE_DISQUALIFY_THRESHOLD;
  if (metricsView && metricsView.metrics?.requestCount >= 5 && metricsView.errorRate > errorRateLimit) {
    reasons.push(`error rate ${metricsView.errorRate.toFixed(1)}% above threshold ${errorRateLimit}%`);
  }

  return reasons.length === 0 ? ["eligible"] : reasons;
}

// ─── Strategy ─────────────────────────────────────────────────────────────────

function compareByStrategy(strategy, left, right, metricsMap, request) {
  switch (strategy) {
    case "lowest-latency":
      return (left.baseLatencyMs ?? 0) - (right.baseLatencyMs ?? 0);
    case "lowest-cost":
      return (left.costPerRequest ?? 0) - (right.costPerRequest ?? 0);
    case "priority":
      // Priority-based routing: select the vendor with the highest priority configuration (lowest number)
      return (left.priority ?? 0) - (right.priority ?? 0);
    case "failover":
      // Failover routing: establishes the sequence of secondary/backup attempts if the primary fails
      return (left.priority ?? 0) - (right.priority ?? 0);
    case "feature-based":
      return (right.supportedFeatures?.length ?? 0) - (left.supportedFeatures?.length ?? 0);
    case "health-based": {
      // Health-based routing: sorts strictly by live success rate (descending) and error rate (ascending)
      const leftMv = metricsMap.get(left.id ?? left._id?.toString());
      const rightMv = metricsMap.get(right.id ?? right._id?.toString());
      if (!leftMv && !rightMv) return 0;
      if (!leftMv) return 1;
      if (!rightMv) return -1;
      if (leftMv.successRate !== rightMv.successRate) {
        return (rightMv.successRate ?? 0) - (leftMv.successRate ?? 0);
      }
      return (leftMv.errorRate ?? 0) - (rightMv.errorRate ?? 0);
    }
    case "weighted":
    default:
      return (
        getVendorScore(right, metricsMap.get(right.id ?? right._id?.toString()), request) -
        getVendorScore(left, metricsMap.get(left.id ?? left._id?.toString()), request)
      );
  }
}

function resolveStrategy(requirements) {
  const explicit = requirements?.strategy;
  if (!explicit && requirements?.preferLowCost === true) return "lowest-cost";
  return explicit ?? "weighted";
}

// ─── Routing reason builders ──────────────────────────────────────────────────

function buildWeightedReason(request, selectedVendor, candidates) {
  const ranked = candidates
    .map((c) => ({ name: c.vendor.name, score: c.score }))
    .sort((a, b) => b.score - a.score);

  const winner = ranked.find((r) => r.name === selectedVendor.name) ?? ranked[0];
  const runnersUp = ranked.filter((r) => r.name !== selectedVendor.name).slice(0, 2);
  const scoreSummary = ranked.slice(0, 3).map((r) => `${r.name}: ${r.score.toFixed(2)}`).join(", ");

  return [
    `${selectedVendor.name} was selected for ${request.capability} with the highest weighted score (${winner?.score.toFixed(2) ?? "0.00"}).`,
    `Score comparison — ${scoreSummary}.`,
    runnersUp.length ? "It ranked above the next best eligible vendors." : "It was the only eligible vendor."
  ].join(" ");
}

function buildRoutingReason(request, strategy, selectedVendor, candidates) {
  if (strategy === "weighted") return buildWeightedReason(request, selectedVendor, candidates);
  if (strategy === "priority") return `${selectedVendor.name} was selected with the best priority (${selectedVendor.priority}) for ${request.capability}.`;
  if (strategy === "lowest-latency") return `${selectedVendor.name} was selected for lowest latency (${selectedVendor.baseLatencyMs ?? "?"}ms).`;
  if (strategy === "lowest-cost") return `${selectedVendor.name} was selected for lowest cost (₹${selectedVendor.costPerRequest ?? "?"}).`;
  if (strategy === "feature-based") return `${selectedVendor.name} was selected because it supported the required features.`;
  if (strategy === "health-based") return `${selectedVendor.name} was selected for the best health and success metrics.`;
  if (strategy === "failover") return `${selectedVendor.name} was selected as the first healthy fallback vendor.`;
  if (strategy === "round-robin") return `${selectedVendor.name} was selected by round-robin rotation.`;
  return `${selectedVendor.name} was selected using the ${strategy} strategy.`;
}

// ─── Candidate selection (async) ──────────────────────────────────────────────

/**
 * Builds Map<vendorId, metricsView> from already-loaded vendor list.
 * Called once per routeRequest — no extra DB query.
 */
function buildMetricsMap(vendors) {
  const map = new Map();
  for (const vendor of vendors) {
    const view = buildVendorMetricsView(vendor);
    const key = vendor.id ?? vendor._id?.toString();
    map.set(key, view);
  }
  return map;
}

async function selectCandidates(request, strategy, allVendors, metricsMap) {
  const forCapability = allVendors.filter((v) => v.capability === request.capability);

  if (strategy === "round-robin") {
    const eligible = forCapability.filter((v) =>
      vendorMeetsRequirements(v, request, metricsMap.get(v.id ?? v._id?.toString())).ok
    );
    if (eligible.length === 0) return [];

    const index = (await getRoundRobinIndex(request.capability)) % eligible.length;
    const nextIndex = (index + 1) % eligible.length;
    await incrementRoundRobinCounter(request.capability, nextIndex);

    return [...eligible.slice(index), ...eligible.slice(0, index)].map((vendor) => ({
      vendor,
      reason: "round-robin rotation"
    }));
  }

  return forCapability
    .map((vendor) => {
      const mv = metricsMap.get(vendor.id ?? vendor._id?.toString());
      return { vendor, ...vendorMeetsRequirements(vendor, request, mv) };
    })
    .filter((item) => item.ok)
    .map((item) => ({ vendor: item.vendor, reason: strategy }))
    .sort((a, b) => compareByStrategy(strategy, a.vendor, b.vendor, metricsMap, request));
}

// ─── Vendor simulation ────────────────────────────────────────────────────────

function simulateVendorResponse(request, vendor) {
  const avgLatency =
    (vendor.metrics?.requestCount ?? 0) === 0
      ? (vendor.baseLatencyMs ?? 900)
      : (vendor.metrics.totalLatencyMs ?? 0) / vendor.metrics.requestCount;

  const jitter = Math.max(50, Math.round(avgLatency * 0.12));
  const latencyMs = Math.max(120, Math.round(avgLatency + (Math.random() * jitter * 2 - jitter)));
  const timeoutMs = request.requirements?.timeoutMs ?? vendor.timeoutMs ?? 2500;

  if (latencyMs > timeoutMs) {
    return { latencyMs, response: {}, success: false, failureReason: "timeout exceeded" };
  }

  const requestCount = vendor.metrics?.requestCount ?? 0;
  const failureCount = vendor.metrics?.failureCount ?? 0;
  const failureRate = clamp(requestCount === 0 ? 5 : (failureCount / requestCount) * 100, 0, 45);
  if (Math.random() * 100 < failureRate) {
    return { latencyMs, response: {}, success: false, failureReason: "vendor returned a transient failure" };
  }

  const payload = request.payload;
  if (request.capability === "PAN_VERIFICATION") {
    const pan = String(payload.pan ?? "");
    const name = String(payload.name ?? "");
    const panStatus = pan.length >= 10 ? "VALID" : "INVALID";
    return {
      latencyMs,
      response: { panStatus, nameMatch: name.trim().length > 0 && panStatus === "VALID", referenceId: randomUUID() },
      success: true
    };
  }

  return {
    latencyMs,
    response: { status: "PROCESSED", referenceId: randomUUID(), echo: payload },
    success: true
  };
}

// ─── Metrics update (async — writes to MongoDB) ───────────────────────────────

async function applyMetrics(vendor, latencyMs, success) {
  const consecutiveFailures = success ? 0 : ((vendor.metrics?.consecutiveFailures ?? 0) + 1);
  const nextStatus = !success && consecutiveFailures >= 3 ? "DOWN" : (vendor.status ?? "UP");
  const pruned = touchRateLimitWindow(vendor);

  const updatedVendor = {
    ...pruned,
    status: nextStatus,
    recentRequestTimestamps: [...(pruned.recentRequestTimestamps ?? []), Date.now()],
    metrics: {
      requestCount: (vendor.metrics?.requestCount ?? 0) + 1,
      successCount: (vendor.metrics?.successCount ?? 0) + (success ? 1 : 0),
      failureCount: (vendor.metrics?.failureCount ?? 0) + (success ? 0 : 1),
      consecutiveFailures,
      totalLatencyMs: (vendor.metrics?.totalLatencyMs ?? 0) + latencyMs,
      lastLatencyMs: latencyMs,
      lastRequestAt: new Date()
    }
  };

  await updateVendor(updatedVendor);
  return updatedVendor;
}

// ─── Main entry point (async) ─────────────────────────────────────────────────

export async function routeRequest(request) {
  const strategy = resolveStrategy(request.requirements);
  const requestId = randomUUID();
  const ts = new Date();

  await appendRequestLog({
    requestId,
    capability: request.capability,
    payload: request.payload,
    requirements: request.requirements ?? {},
    timestamp: ts,
    status: "RECEIVED"
  });

  // One DB read — vendors are shared with buildMetricsMap (no double query)
  const allVendors = await listVendors();
  const metricsMap = buildMetricsMap(allVendors);

  const candidates = await selectCandidates(request, strategy, allVendors, metricsMap);

  const candidateSnapshots = candidates.map((c) => {
    const mv = metricsMap.get(c.vendor.id ?? c.vendor._id?.toString());
    return {
      ...c,
      score: getVendorScore(c.vendor, mv, request),
      eligibilityReasons: getEligibilityDetails(c.vendor, request, mv),
      metrics: mv
    };
  });

  if (candidates.length === 0) {
    await appendRequestLog({
      requestId,
      capability: request.capability,
      payload: request.payload,
      requirements: request.requirements ?? {},
      timestamp: new Date(),
      status: "FAILED",
      reason: "No eligible vendor matched the request requirements"
    });
    return {
      status: "FAILED",
      vendorUsed: null,
      routingReason: "No eligible vendor matched the request requirements",
      error: "no eligible vendor found"
    };
  }

  for (const candidate of candidates) {
    const execution = simulateVendorResponse(request, candidate.vendor);
    const updatedVendor = await applyMetrics(candidate.vendor, execution.latencyMs, execution.success);

    if (execution.success) {
      const routingReason = buildRoutingReason(request, strategy, updatedVendor, candidateSnapshots);
      const successResponse = {
        status: "SUCCESS",
        vendorUsed: updatedVendor.name,
        routingReason,
        latencyMs: execution.latencyMs,
        cost: updatedVendor.costPerRequest ?? 0,
        response: execution.response
      };

      await Promise.all([
        appendRoutingLog({
          requestId,
          capability: request.capability,
          vendorUsed: updatedVendor.name,
          strategy,
          routingReason,
          latencyMs: execution.latencyMs,
          cost: updatedVendor.costPerRequest ?? 0,
          success: true,
          timestamp: new Date()
        }),
        appendRequestLog({
          requestId,
          capability: request.capability,
          payload: request.payload,
          requirements: request.requirements ?? {},
          vendorUsed: updatedVendor.name,
          strategy,
          latencyMs: execution.latencyMs,
          status: "SUCCESS",
          timestamp: new Date()
        })
      ]);

      return successResponse;
    }

    const fallbackReason = `Fallback from ${updatedVendor.name}: ${execution.failureReason}`;

    await Promise.all([
      appendRoutingLog({
        requestId,
        capability: request.capability,
        vendorUsed: updatedVendor.name,
        strategy,
        routingReason: fallbackReason,
        latencyMs: execution.latencyMs,
        cost: updatedVendor.costPerRequest ?? 0,
        success: false,
        timestamp: new Date()
      }),
      appendRequestLog({
        requestId,
        capability: request.capability,
        payload: request.payload,
        requirements: request.requirements ?? {},
        vendorUsed: updatedVendor.name,
        strategy,
        latencyMs: execution.latencyMs,
        status: "FAILED",
        reason: execution.failureReason,
        timestamp: new Date()
      })
    ]);
  }

  await appendRequestLog({
    requestId,
    capability: request.capability,
    payload: request.payload,
    requirements: request.requirements ?? {},
    timestamp: new Date(),
    status: "FAILED",
    reason: "All candidate vendors failed or timed out"
  });

  return {
    status: "FAILED",
    vendorUsed: null,
    routingReason: "All candidate vendors failed or timed out",
    error: "all vendor attempts failed"
  };
}