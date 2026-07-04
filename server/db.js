import mongoose from "mongoose";

// ─── Connection ───────────────────────────────────────────────────────────────

const MONGO_URI = process.env.MONGO_URI ?? "mongodb://localhost:27017/signzy-vendor-router";

export async function connectDB() {
  await mongoose.connect(MONGO_URI);
  console.log("MongoDB connected");
}

// ─── Sub-schemas ──────────────────────────────────────────────────────────────

const metricsSchema = new mongoose.Schema(
  {
    requestCount:       { type: Number, default: 0 },
    successCount:       { type: Number, default: 0 },
    failureCount:       { type: Number, default: 0 },
    consecutiveFailures:{ type: Number, default: 0 },
    totalLatencyMs:     { type: Number, default: 0 },
    lastLatencyMs:      { type: Number, default: 0 },
    lastRequestAt:      { type: Date,   default: null }
  },
  { _id: false }
);

// ─── Vendor ───────────────────────────────────────────────────────────────────

const vendorSchema = new mongoose.Schema(
  {
    name:                   { type: String, required: true },
    capability:             { type: String, required: true },
    weight:                 { type: Number, default: 50 },
    costPerRequest:         { type: Number, default: 100.0 },
    timeoutMs:              { type: Number, default: 2500 },
    rateLimitPerMinute:     { type: Number, default: 100 },
    priority:               { type: Number, default: 1 },
    supportedFeatures:      { type: [String], default: [] },
    strategy:               { type: String, default: "weighted" },
    baseLatencyMs:          { type: Number, default: 900 },
    enabled:                { type: Boolean, default: true },
    status:                 { type: String, enum: ["UP", "DOWN"], default: "UP" },
    metrics:                { type: metricsSchema, default: () => ({}) },
    // Stored as unix ms timestamps for fast rate-limit window checks
    recentRequestTimestamps:{ type: [Number], default: [] }
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: false },
    // Expose _id as `id` (string) and omit __v from responses
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    }
  }
);

// Compound unique index: one vendor per (name, capability) pair
vendorSchema.index({ name: 1, capability: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });

export const Vendor = mongoose.model("Vendor", vendorSchema);

// ─── RoutingLog ───────────────────────────────────────────────────────────────

const routingLogSchema = new mongoose.Schema(
  {
    requestId:    { type: String, required: true },
    capability:   { type: String, required: true },
    vendorUsed:   { type: String },
    strategy:     { type: String },
    routingReason:{ type: String },
    latencyMs:    { type: Number },
    cost:         { type: Number },
    success:      { type: Boolean },
    timestamp:    { type: Date, default: Date.now }
  },
  {
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    }
  }
);

// TTL index: auto-delete logs older than 30 days
routingLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export const RoutingLog = mongoose.model("RoutingLog", routingLogSchema);

// ─── RequestLog ───────────────────────────────────────────────────────────────

const requestLogSchema = new mongoose.Schema(
  {
    requestId:  { type: String, required: true },
    capability: { type: String, required: true },
    payload:    { type: mongoose.Schema.Types.Mixed },
    requirements:{ type: mongoose.Schema.Types.Mixed },
    vendorUsed: { type: String },
    strategy:   { type: String },
    latencyMs:  { type: Number },
    status:     { type: String },
    reason:     { type: String },
    timestamp:  { type: Date, default: Date.now }
  },
  {
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      }
    }
  }
);

// TTL index: auto-delete logs older than 30 days
requestLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export const RequestLog = mongoose.model("RequestLog", requestLogSchema);

// ─── RoundRobinCounter ────────────────────────────────────────────────────────

const roundRobinCounterSchema = new mongoose.Schema({
  capability: { type: String, required: true, unique: true },
  counter:    { type: Number, default: 0 }
});

export const RoundRobinCounter = mongoose.model("RoundRobinCounter", roundRobinCounterSchema);

// ─── Seed data ────────────────────────────────────────────────────────────────

const seedVendors = [
  {
    name: "VendorA",
    capability: "PAN_VERIFICATION",
    weight: 70,
    costPerRequest: 150,
    timeoutMs: 2000,
    rateLimitPerMinute: 100,
    priority: 1,
    supportedFeatures: ["name-match", "pan-status"],
    strategy: "weighted",
    baseLatencyMs: 1200,
    enabled: true,
    status: "UP"
  },
  {
    name: "VendorB",
    capability: "PAN_VERIFICATION",
    weight: 30,
    costPerRequest: 120,
    timeoutMs: 3000,
    rateLimitPerMinute: 50,
    priority: 2,
    supportedFeatures: ["name-match", "pan-status", "low-cost"],
    strategy: "priority",
    baseLatencyMs: 850,
    enabled: true,
    status: "UP"
  },
  {
    name: "VendorC",
    capability: "PAN_VERIFICATION",
    weight: 50,
    costPerRequest: 110,
    timeoutMs: 2500,
    rateLimitPerMinute: 80,
    priority: 3,
    supportedFeatures: ["name-match", "pan-status"],
    strategy: "health-based",
    baseLatencyMs: 1000,
    enabled: true,
    status: "UP"
  }
];

/**
 * Seeds the database with default vendors only when the collection is empty.
 * Safe to call on every startup — idempotent.
 */
export async function seedIfEmpty() {
  const count = await Vendor.countDocuments();
  if (count > 0) {
    console.log(`Skipping seed — ${count} vendor(s) already in database.`);
    return;
  }
  await Vendor.insertMany(seedVendors);
  console.log(`Seeded ${seedVendors.length} default vendors into MongoDB.`);
}
