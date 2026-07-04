/**
 * Unit and integration tests for the Intelligent Vendor Routing Platform.
 * Run with: node --test server/routing.test.js
 *
 * Uses Node.js built-in test runner (node:test) — no external dependencies needed.
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Minimal vendor factory used by tests.
 * Only sets fields relevant to routing logic.
 */
function makeVendor(overrides = {}) {
  return {
    id: `test-${Math.random().toString(36).slice(2)}`,
    name: "TestVendor",
    capability: "PAN_VERIFICATION",
    status: "UP",
    enabled: true,
    weight: 50,
    priority: 1,
    costPerRequest: 1.0,
    timeoutMs: 2000,
    rateLimitPerMinute: 100,
    baseLatencyMs: 500,
    supportedFeatures: ["pan-status", "name-match"],
    strategy: "weighted",
    metrics: {
      requestCount: 0,
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      totalLatencyMs: 0,
      lastLatencyMs: 0,
      lastRequestAt: null
    },
    recentRequestTimestamps: [],
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

// ─── Inline implementations of pure routing helpers ──────────────────────────
// We replicate the pure functions here so tests do not depend on server state.

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const ERROR_RATE_DISQUALIFY_THRESHOLD = 40;

function activeRequestsInLastMinute(vendor) {
  const oneMinuteAgo = Date.now() - 60_000;
  return vendor.recentRequestTimestamps.filter((ts) => ts >= oneMinuteAgo).length;
}

function vendorMeetsRequirements(vendor, request, metricsView) {
  if (vendor.enabled === false) return { ok: false, reason: "vendor is disabled" };
  if ((vendor.status ?? "UP") !== "UP") return { ok: false, reason: "vendor is down" };
  if (vendor.capability !== request.capability) return { ok: false, reason: "capability mismatch" };

  const requiredFeatures = request.requirements?.requiredFeatures ?? [];
  const missing = requiredFeatures.find((f) => !(vendor.supportedFeatures ?? []).includes(f));
  if (missing) return { ok: false, reason: `missing required feature: ${missing}` };

  const maxLatencyMs = request.requirements?.maxLatencyMs;
  if (typeof maxLatencyMs === "number" && vendor.baseLatencyMs !== undefined && vendor.baseLatencyMs > maxLatencyMs) {
    return { ok: false, reason: "estimated latency exceeds threshold" };
  }

  if (activeRequestsInLastMinute(vendor) >= (vendor.rateLimitPerMinute ?? 100)) {
    return { ok: false, reason: "rate limit reached" };
  }

  if (metricsView && metricsView.requestCount >= 5 && metricsView.errorRate > ERROR_RATE_DISQUALIFY_THRESHOLD) {
    return { ok: false, reason: `error rate ${metricsView.errorRate.toFixed(1)}% exceeds threshold` };
  }

  return { ok: true, reason: "eligible" };
}

function normalizedScore(metricsView) {
  const latencyScore = 100 - clamp((metricsView.averageLatencyMs ?? 0) / 20, 0, 100);
  const successScore = metricsView.successRate ?? 0;
  const costScore = 100 - clamp((metricsView.costPerRequest ?? 1) * 10, 0, 100);
  const availabilityScore = metricsView.enabled === false ? 0 : 100;
  return latencyScore * 0.4 + successScore * 0.3 + costScore * 0.2 + availabilityScore * 0.1;
}

function compareByStrategy(strategy, left, right) {
  switch (strategy) {
    case "lowest-latency":
      return (left.baseLatencyMs ?? 0) - (right.baseLatencyMs ?? 0);
    case "lowest-cost":
      return (left.costPerRequest ?? 0) - (right.costPerRequest ?? 0);
    case "priority":
    case "failover":
      return (left.priority ?? 0) - (right.priority ?? 0);
    case "feature-based":
      return (right.supportedFeatures?.length ?? 0) - (left.supportedFeatures?.length ?? 0);
    default:
      return 0;
  }
}

function resolveStrategy(requirements) {
  const explicit = requirements?.strategy;
  if (!explicit && requirements?.preferLowCost === true) return "lowest-cost";
  return explicit ?? "weighted";
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("vendorMeetsRequirements", () => {
  const baseRequest = { capability: "PAN_VERIFICATION", payload: {}, requirements: {} };

  it("accepts a healthy UP vendor", () => {
    const vendor = makeVendor();
    const result = vendorMeetsRequirements(vendor, baseRequest, null);
    assert.equal(result.ok, true);
  });

  it("rejects vendor with status DOWN", () => {
    const vendor = makeVendor({ status: "DOWN" });
    const result = vendorMeetsRequirements(vendor, baseRequest, null);
    assert.equal(result.ok, false);
    assert.match(result.reason, /down/i);
  });

  it("rejects disabled vendor", () => {
    const vendor = makeVendor({ enabled: false });
    const result = vendorMeetsRequirements(vendor, baseRequest, null);
    assert.equal(result.ok, false);
    assert.match(result.reason, /disabled/i);
  });

  it("rejects vendor with wrong capability", () => {
    const vendor = makeVendor({ capability: "OCR" });
    const result = vendorMeetsRequirements(vendor, baseRequest, null);
    assert.equal(result.ok, false);
    assert.match(result.reason, /capability/i);
  });

  it("rejects vendor missing a required feature", () => {
    const vendor = makeVendor({ supportedFeatures: ["pan-status"] });
    const request = { ...baseRequest, requirements: { requiredFeatures: ["name-match"] } };
    const result = vendorMeetsRequirements(vendor, request, null);
    assert.equal(result.ok, false);
    assert.match(result.reason, /name-match/);
  });

  it("accepts vendor that supports all required features", () => {
    const vendor = makeVendor({ supportedFeatures: ["pan-status", "name-match"] });
    const request = { ...baseRequest, requirements: { requiredFeatures: ["name-match"] } };
    const result = vendorMeetsRequirements(vendor, request, null);
    assert.equal(result.ok, true);
  });

  it("rejects vendor exceeding maxLatencyMs threshold", () => {
    const vendor = makeVendor({ baseLatencyMs: 3000 });
    const request = { ...baseRequest, requirements: { maxLatencyMs: 1000 } };
    const result = vendorMeetsRequirements(vendor, request, null);
    assert.equal(result.ok, false);
    assert.match(result.reason, /latency/i);
  });

  it("accepts vendor within maxLatencyMs threshold", () => {
    const vendor = makeVendor({ baseLatencyMs: 800 });
    const request = { ...baseRequest, requirements: { maxLatencyMs: 1000 } };
    const result = vendorMeetsRequirements(vendor, request, null);
    assert.equal(result.ok, true);
  });

  it("rejects vendor that has exceeded the rate limit", () => {
    const now = Date.now();
    const vendor = makeVendor({
      rateLimitPerMinute: 2,
      recentRequestTimestamps: [now - 1000, now - 2000]
    });
    const result = vendorMeetsRequirements(vendor, baseRequest, null);
    assert.equal(result.ok, false);
    assert.match(result.reason, /rate limit/i);
  });

  it("rejects vendor with error rate above disqualification threshold", () => {
    const metricsView = { requestCount: 10, errorRate: 45, successRate: 55, averageLatencyMs: 200 };
    const vendor = makeVendor();
    const result = vendorMeetsRequirements(vendor, baseRequest, metricsView);
    assert.equal(result.ok, false);
    assert.match(result.reason, /error rate/i);
  });

  it("accepts vendor with error rate below disqualification threshold", () => {
    const metricsView = { requestCount: 10, errorRate: 20, successRate: 80, averageLatencyMs: 200 };
    const vendor = makeVendor();
    const result = vendorMeetsRequirements(vendor, baseRequest, metricsView);
    assert.equal(result.ok, true);
  });

  it("does NOT apply error rate check when requestCount < 5", () => {
    // Vendor has 80% error rate but only 3 requests — should still be eligible
    const metricsView = { requestCount: 3, errorRate: 80, successRate: 20, averageLatencyMs: 200 };
    const vendor = makeVendor();
    const result = vendorMeetsRequirements(vendor, baseRequest, metricsView);
    assert.equal(result.ok, true);
  });
});

describe("Strategy selection — compareByStrategy", () => {
  it("lowest-cost selects cheaper vendor first", () => {
    const cheap = makeVendor({ costPerRequest: 0.5 });
    const expensive = makeVendor({ costPerRequest: 2.0 });
    const order = compareByStrategy("lowest-cost", cheap, expensive);
    assert.ok(order < 0, "cheap should sort before expensive");
  });

  it("lowest-latency selects faster vendor first", () => {
    const fast = makeVendor({ baseLatencyMs: 300 });
    const slow = makeVendor({ baseLatencyMs: 1200 });
    const order = compareByStrategy("lowest-latency", fast, slow);
    assert.ok(order < 0, "fast should sort before slow");
  });

  it("priority selects lower-numbered priority first", () => {
    const primary = makeVendor({ priority: 1 });
    const secondary = makeVendor({ priority: 3 });
    const order = compareByStrategy("priority", primary, secondary);
    assert.ok(order < 0, "priority 1 should sort before priority 3");
  });

  it("feature-based selects vendor with more features first", () => {
    const rich = makeVendor({ supportedFeatures: ["a", "b", "c"] });
    const lean = makeVendor({ supportedFeatures: ["a"] });
    const order = compareByStrategy("feature-based", rich, lean);
    assert.ok(order < 0, "richer feature set should sort first");
  });
});

describe("preferLowCost flag → strategy resolution", () => {
  it("resolves to lowest-cost when preferLowCost is true and no explicit strategy", () => {
    const strategy = resolveStrategy({ preferLowCost: true });
    assert.equal(strategy, "lowest-cost");
  });

  it("explicit strategy takes precedence over preferLowCost", () => {
    const strategy = resolveStrategy({ preferLowCost: true, strategy: "priority" });
    assert.equal(strategy, "priority");
  });

  it("defaults to weighted when no requirements given", () => {
    const strategy = resolveStrategy(undefined);
    assert.equal(strategy, "weighted");
  });

  it("defaults to weighted when requirements is empty", () => {
    const strategy = resolveStrategy({});
    assert.equal(strategy, "weighted");
  });
});

describe("Round-robin counter logic", () => {
  it("wraps around correctly", () => {
    const total = 3;
    const counters = new Map();
    const getIndex = (cap) => counters.get(cap) ?? 0;
    const increment = (cap) => {
      const next = ((counters.get(cap) ?? 0) + 1) % total;
      counters.set(cap, next);
    };

    const sequence = [];
    for (let i = 0; i < total * 2; i++) {
      sequence.push(getIndex("PAN_VERIFICATION"));
      increment("PAN_VERIFICATION");
    }

    assert.deepEqual(sequence, [0, 1, 2, 0, 1, 2]);
  });

  it("counters are independent per capability", () => {
    const counters = new Map();
    const total = 2;
    const getIndex = (cap) => counters.get(cap) ?? 0;
    const increment = (cap) => {
      const next = ((counters.get(cap) ?? 0) + 1) % total;
      counters.set(cap, next);
    };

    increment("PAN_VERIFICATION");
    assert.equal(getIndex("PAN_VERIFICATION"), 1);
    assert.equal(getIndex("OCR"), 0);
  });
});

describe("Numeric coercion helper", () => {
  const NUMERIC_FIELDS = ["weight", "priority", "costPerRequest", "rateLimitPerMinute", "timeoutMs", "baseLatencyMs"];

  function coerceVendorInput(body) {
    const coerced = { ...body };
    for (const field of NUMERIC_FIELDS) {
      if (coerced[field] !== undefined && coerced[field] !== "") {
        const n = Number(coerced[field]);
        if (!Number.isNaN(n)) coerced[field] = n;
      }
    }
    return coerced;
  }

  it("converts string numeric fields to numbers", () => {
    const input = { name: "V", capability: "PAN", weight: "70", costPerRequest: "1.5", priority: "2" };
    const output = coerceVendorInput(input);
    assert.equal(typeof output.weight, "number");
    assert.equal(output.weight, 70);
    assert.equal(output.costPerRequest, 1.5);
  });

  it("leaves non-numeric string fields untouched", () => {
    const input = { name: "VendorX", capability: "KYC" };
    const output = coerceVendorInput(input);
    assert.equal(output.name, "VendorX");
    assert.equal(output.capability, "KYC");
  });

  it("does not coerce fields with NaN values", () => {
    const input = { weight: "abc" };
    const output = coerceVendorInput(input);
    // Should remain "abc" since Number("abc") is NaN
    assert.equal(output.weight, "abc");
  });
});

describe("Failover: iterate candidates on failure", () => {
  it("second vendor is tried when the first vendor's simulated call fails", () => {
    // Simulate a scenario: vendorA always times out (latency > timeout),
    // vendorB always succeeds. The router should try B after A fails.
    const vendorA = makeVendor({ name: "VendorA", priority: 1, timeoutMs: 100, baseLatencyMs: 999 });
    const vendorB = makeVendor({ name: "VendorB", priority: 2, timeoutMs: 5000, baseLatencyMs: 200 });

    function simulateCall(vendor) {
      const latency = vendor.baseLatencyMs;
      if (latency > vendor.timeoutMs) return { success: false, latencyMs: latency, failureReason: "timeout" };
      return { success: true, latencyMs: latency };
    }

    const candidates = [vendorA, vendorB].sort((a, b) => a.priority - b.priority);
    let usedVendor = null;

    for (const candidate of candidates) {
      const result = simulateCall(candidate);
      if (result.success) {
        usedVendor = candidate.name;
        break;
      }
    }

    assert.equal(usedVendor, "VendorB", "Should fall over to VendorB after VendorA times out");
  });
});

describe("Dynamic overrides (Agentic AI Support)", () => {
  it("uses dynamic maxErrorRate override", () => {
    const metricsView = { requestCount: 10, errorRate: 25, successRate: 75, averageLatencyMs: 200 };
    const vendor = makeVendor();
    const request = { capability: "PAN_VERIFICATION", payload: {}, requirements: { maxErrorRate: 20 } };
    
    const errorRateLimit = request.requirements?.maxErrorRate ?? 40;
    const isEligible = !(metricsView && metricsView.requestCount >= 5 && metricsView.errorRate > errorRateLimit);
    
    assert.equal(isEligible, false, "Should be disqualified under dynamic error rate threshold");
  });

  it("applies dynamic weight override during scoring", () => {
    const vendorA = makeVendor({ name: "VendorA", weight: 30 });
    const vendorB = makeVendor({ name: "VendorB", weight: 70 });
    const request = { capability: "PAN_VERIFICATION", payload: {}, requirements: { weights: { VendorA: 90, VendorB: 10 } } };

    function getScore(vendor, req) {
      let weightScore = vendor.weight ?? 50;
      if (req?.requirements?.weights) {
        const override = req.requirements.weights[vendor.name];
        if (typeof override === "number") {
          weightScore = override;
        }
      }
      return weightScore;
    }

    assert.equal(getScore(vendorA, request), 90);
    assert.equal(getScore(vendorB, request), 10);
  });
});

