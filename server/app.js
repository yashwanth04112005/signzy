import cors from "cors";
import express from "express";
import mongoose from "mongoose";
import {
  addVendor,
  deleteVendor,
  findDuplicateVendor,
  getRequestLogs,
  getRoutingLogs,
  getVendorById,
  getVendorMetricsViews,
  listVendors,
  setVendorStatus,
  updateVendor
} from "./store.js";
import { routeRequest } from "./routing.js";

export const app = express();

app.use(cors());
app.use(express.json());

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NUMERIC_VENDOR_FIELDS = ["weight", "priority", "costPerRequest", "rateLimitPerMinute", "timeoutMs", "baseLatencyMs"];

/**
 * Coerce all known numeric fields from string → number so that form submissions
 * from the UI (which always produce strings) don't silently break routing math.
 */
function coerceVendorInput(body) {
  const coerced = { ...body };
  for (const field of NUMERIC_VENDOR_FIELDS) {
    if (coerced[field] !== undefined && coerced[field] !== "") {
      const n = Number(coerced[field]);
      if (!Number.isNaN(n)) coerced[field] = n;
    }
  }
  return coerced;
}

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/health", async (_request, response, next) => {
  try {
    const vendors = await listVendors();
    response.json({
      status: "ok",
      service: "intelligent-vendor-router",
      vendors: vendors.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    next(error);
  }
});

// ─── Vendors ──────────────────────────────────────────────────────────────────

app.get("/vendors", async (_request, response, next) => {
  try {
    response.json({ vendors: await listVendors() });
  } catch (error) {
    next(error);
  }
});

app.get("/vendors/:id", async (request, response, next) => {
  try {
    if (!mongoose.isValidObjectId(request.params.id)) {
      response.status(400).json({ error: "invalid vendor id" });
      return;
    }
    const vendor = await getVendorById(request.params.id);
    if (!vendor) {
      response.status(404).json({ error: "vendor not found" });
      return;
    }
    response.json({ vendor });
  } catch (error) {
    next(error);
  }
});

app.post("/vendors", async (request, response, next) => {
  try {
    const body = coerceVendorInput(request.body);

    if (!body?.name || !body?.capability) {
      response.status(400).json({ error: "name and capability are required" });
      return;
    }

    const duplicate = await findDuplicateVendor(body);
    if (duplicate) {
      response.status(409).json({
        error: "vendor already exists for this capability",
        existingVendor: duplicate
      });
      return;
    }

    response.status(201).json({ vendor: await addVendor(body) });
  } catch (error) {
    next(error);
  }
});

app.put("/vendors/:id", async (request, response, next) => {
  try {
    if (!mongoose.isValidObjectId(request.params.id)) {
      response.status(400).json({ error: "invalid vendor id" });
      return;
    }
    const existing = await getVendorById(request.params.id);
    if (!existing) {
      response.status(404).json({ error: "vendor not found" });
      return;
    }

    const updates = coerceVendorInput(request.body);

    // Protect immutable fields
    const { id: _id, _id: _mongoId, createdAt: _c, metrics: _m, recentRequestTimestamps: _r, ...allowedUpdates } = updates;

    const updated = await updateVendor({ ...existing, ...allowedUpdates });
    response.json({ vendor: updated });
  } catch (error) {
    next(error);
  }
});

app.patch("/vendors/:id/status", async (request, response, next) => {
  try {
    const status = String(request.body?.status ?? "").toUpperCase();

    if (!["UP", "DOWN"].includes(status)) {
      response.status(400).json({ error: "status must be UP or DOWN" });
      return;
    }

    const updated = await setVendorStatus(request.params.id, status);
    if (!updated) {
      response.status(404).json({ error: "vendor not found" });
      return;
    }

    response.json({ vendor: updated });
  } catch (error) {
    next(error);
  }
});

app.delete("/vendors/:id", async (request, response, next) => {
  try {
    if (!mongoose.isValidObjectId(request.params.id)) {
      response.status(400).json({ error: "invalid vendor id" });
      return;
    }
    const existing = await getVendorById(request.params.id);
    if (!existing) {
      response.status(404).json({ error: "vendor not found" });
      return;
    }

    await deleteVendor(request.params.id);
    response.status(200).json({ message: `Vendor ${existing.name} deleted successfully` });
  } catch (error) {
    next(error);
  }
});

// ─── Routing ──────────────────────────────────────────────────────────────────

app.post("/route", async (request, response, next) => {
  try {
    const body = request.body;

    if (!body?.capability || !body?.payload) {
      response.status(400).json({ error: "capability and payload are required" });
      return;
    }

    response.json(await routeRequest(body));
  } catch (error) {
    next(error);
  }
});

// ─── Metrics & Logs ───────────────────────────────────────────────────────────

app.get("/vendor-metrics", async (_request, response, next) => {
  try {
    response.json({ metrics: await getVendorMetricsViews() });
  } catch (error) {
    next(error);
  }
});

app.get("/routing-logs", async (_request, response, next) => {
  try {
    response.json({ logs: await getRoutingLogs() });
  } catch (error) {
    next(error);
  }
});

app.get("/request-logs", async (_request, response, next) => {
  try {
    response.json({ logs: await getRequestLogs() });
  } catch (error) {
    next(error);
  }
});

// ─── Error handler ────────────────────────────────────────────────────────────

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({
    error: error.message,
    status: "FAILED"
  });
});