import { Vendor, RoutingLog, RequestLog, RoundRobinCounter } from "./db.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

// ─── Vendor CRUD ──────────────────────────────────────────────────────────────

export async function listVendors() {
  const vendors = await Vendor.find().lean({ virtuals: true });
  return vendors;
}

export async function getVendorById(id) {
  const vendor = await Vendor.findById(id).lean({ virtuals: true });
  return vendor ?? undefined;
}

export async function findDuplicateVendor(input) {
  const vendor = await Vendor.findOne({
    name: { $regex: new RegExp(`^${normalizeKey(input.name)}$`, "i") },
    capability: { $regex: new RegExp(`^${normalizeKey(input.capability)}$`, "i") }
  }).lean({ virtuals: true });
  return vendor ?? undefined;
}

export async function addVendor(input) {
  const vendor = await new Vendor(input).save();
  return vendor.toJSON();
}

export async function updateVendor(vendor) {
  const { id, _id, ...rest } = vendor;
  const mongoId = id ?? _id;
  const updated = await Vendor.findByIdAndUpdate(mongoId, { $set: rest }, { new: true }).lean({ virtuals: true });
  return updated;
}

export async function setVendorStatus(id, status) {
  const updated = await Vendor.findByIdAndUpdate(id, { $set: { status } }, { new: true }).lean({ virtuals: true });
  return updated ?? undefined;
}

export async function deleteVendor(id) {
  const result = await Vendor.findByIdAndDelete(id);
  return result !== null;
}

// ─── Metrics helpers (pure — operate on already-loaded vendor objects) ─────────

export function activeRequestsInLastMinute(vendor) {
  const oneMinuteAgo = Date.now() - 60_000;
  return (vendor.recentRequestTimestamps ?? []).filter((ts) => ts >= oneMinuteAgo).length;
}

export function touchRateLimitWindow(vendor) {
  const oneMinuteAgo = Date.now() - 60_000;
  return {
    ...vendor,
    recentRequestTimestamps: (vendor.recentRequestTimestamps ?? []).filter((ts) => ts >= oneMinuteAgo)
  };
}

export function buildVendorMetricsView(vendor) {
  const requestCount = vendor.metrics?.requestCount ?? 0;
  const successCount = vendor.metrics?.successCount ?? 0;
  const failureCount = vendor.metrics?.failureCount ?? 0;
  const totalLatencyMs = vendor.metrics?.totalLatencyMs ?? 0;
  const averageLatencyMs = requestCount === 0 ? 0 : totalLatencyMs / requestCount;
  const availability = requestCount === 0 ? 100 : (successCount / requestCount) * 100;
  const errorRate = requestCount === 0 ? 0 : (failureCount / requestCount) * 100;
  const rateLimitPerMinute = vendor.rateLimitPerMinute ?? 100;

  return {
    ...vendor,
    availability,
    successRate: availability,
    errorRate,
    averageLatencyMs,
    healthStatus: vendor.status ?? "UP",
    rateLimitRemaining: Math.max(rateLimitPerMinute - activeRequestsInLastMinute(vendor), 0)
  };
}

export async function getVendorMetricsViews() {
  const vendors = await listVendors();
  return vendors.map(buildVendorMetricsView);
}

// ─── Round-robin counter ──────────────────────────────────────────────────────

export async function getRoundRobinIndex(capability) {
  const doc = await RoundRobinCounter.findOne({ capability }).lean();
  return doc?.counter ?? 0;
}

export async function incrementRoundRobinCounter(capability, nextIndex) {
  // Atomic upsert — safe under concurrent requests, no race condition
  await RoundRobinCounter.findOneAndUpdate(
    { capability },
    { $set: { counter: nextIndex } },
    { upsert: true, new: true }
  );
}

// ─── Logs ─────────────────────────────────────────────────────────────────────

export async function appendRoutingLog(entry) {
  await new RoutingLog(entry).save();
}

export async function getRoutingLogs() {
  const logs = await RoutingLog.find().sort({ timestamp: -1 }).limit(200).lean({ virtuals: true });
  return logs;
}

export async function appendRequestLog(entry) {
  await new RequestLog(entry).save();
}

export async function getRequestLogs() {
  const logs = await RequestLog.find().sort({ timestamp: -1 }).limit(200).lean({ virtuals: true });
  return logs;
}