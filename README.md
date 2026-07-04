# Intelligent Vendor Routing Platform

A MERN-style intelligent vendor routing platform that exposes one unified API to the client and silently routes each request to the most suitable vendor based on configurable routing rules and live performance signals, persisted via MongoDB.

---

## Architecture

### System Architecture
This diagram groups the platform components into logical layers (Client Dashboard, Platform Backend, Database Persistence, and External Vendors) with clean boxes and directional flow arrows:

```
                ┌──────────────────────────────────────────────┐
                │          Client Dashboard / Web App          │
                └──────────────────────┬───────────────────────┘
                                       │
                                       │ 1. POST /route
                                       ▼
                ┌──────────────────────────────────────────────┐
                │             Express API Router               │
                └───────┬──────────────────────────────▲───────┘
                        │                              │
        2. Fetch        │                              │ 7. Return Response
        Vendors         ▼                              │
        ┌───────────────┴──────────────┐               │
        │    MongoDB Atlas / Local     │               │
        └───────────────┬──────────────┘               │
                        │                              │
        3. Return       │                              │
        Vendor List     ▼                              │
                ┌──────────────────────────────────────┴───────┐
                │          Intelligent Routing Engine          │
                └───────┬──────────────┬──────────────┬────────┘
                        │              │              │
                        │ 4. Attempt   │ 5. Failover  │ 5. Failover
                        ▼              ▼              ▼
                ┌──────────────┐┌──────────────┐┌──────────────┐
                │   Vendor A   ││   Vendor B   ││   Vendor C   │
                │  (Primary)   ││ (Secondary)  ││   (Backup)   │
                └──────────────┘└──────────────┘└──────────────┘
```

---

### Routing Decision Engine Flow
This flowchart maps the exact step-by-step logic the routing engine executes to filter, rank, and failover across candidates:

```
 [1. Request Received]
          │
          ▼
 [2. Fetch Registered Vendors for Capability]
          │
          ▼
 [Candidate Eligibility Filters]
    ├── Status UP & Enabled? ───────▶ [No] Disqualify Candidate
    │     │ Yes
    │     ▼
    ├── Supports Capability? ───────▶ [No] Disqualify Candidate
    │     │ Yes
    │     ▼
    ├── Supports Features? ─────────▶ [No] Disqualify Candidate
    │     │ Yes
    │     ▼
    ├── Latency < Max Allowed? ─────▶ [No] Disqualify Candidate
    │     │ Yes
    │     ▼
    ├── Requests < Rate Limit? ─────▶ [No] Disqualify Candidate
    │     │ Yes
    │     ▼
    └── Error Rate < 40%? ──────────▶ [No] Disqualify Candidate
          │ Yes
          ▼
 [3. Rank Remaining Candidates by Active Strategy]
    (weighted, priority, lowest-cost, lowest-latency, Feature/Health/Round-robin)
          │
          ▼
 [4. Attempt Candidates in Ranked Order (Failover Loop)]
          │
          ├── Success ──▶ [Return Success Response & Update Live Metrics]
          │
          └── Failure ──▶ [Log fallback reason, attempt next candidate]
                            └── If all candidates fail: Return Failure envelope
```

## Sample Vendor Configurations
The database is seeded with 3 default vendors on first run. Their initial configurations look like this:

### 1. VendorA (Primary / High Traffic)
```json
{
  "name": "VendorA",
  "capability": "PAN_VERIFICATION",
  "weight": 70,
  "costPerRequest": 150,
  "timeoutMs": 2000,
  "rateLimitPerMinute": 100,
  "priority": 1,
  "supportedFeatures": ["name-match", "pan-status"],
  "strategy": "weighted",
  "baseLatencyMs": 1200,
  "enabled": true,
  "status": "UP"
}
```

### 2. VendorB (Secondary / Fast & Custom Features)
```json
{
  "name": "VendorB",
  "capability": "PAN_VERIFICATION",
  "weight": 30,
  "costPerRequest": 120,
  "timeoutMs": 3000,
  "rateLimitPerMinute": 50,
  "priority": 2,
  "supportedFeatures": ["name-match", "pan-status", "low-cost"],
  "strategy": "priority",
  "baseLatencyMs": 850,
  "enabled": true,
  "status": "UP"
}
```

### 3. VendorC (Tertiary / Low Cost Backup)
```json
{
  "name": "VendorC",
  "capability": "PAN_VERIFICATION",
  "weight": 50,
  "costPerRequest": 110,
  "timeoutMs": 2500,
  "rateLimitPerMinute": 80,
  "priority": 3,
  "supportedFeatures": ["name-match", "pan-status"],
  "strategy": "health-based",
  "baseLatencyMs": 1000,
  "enabled": true,
  "status": "UP"
}
```

---


## Features

- **8 routing strategies** — weighted, priority, lowest-latency, lowest-cost, failover, round-robin, feature-based, health-based.
- **Auto-switch** when a vendor is DOWN, rate-limited, too slow, missing required features, or has an error rate > 40%.
- **Round-robin** with a persistent per-capability counter (rotates correctly across requests).
- **`preferLowCost` flag** — set `requirements.preferLowCost: true` to automatically apply the lowest-cost strategy.
- **Agentic AI** — plain-English routing config parser, strategy recommendation, unhealthy vendor detection, and fallback rule generator (client-side).
- **Full CRUD vendor management** via REST API.
- **Standardized response** with `vendorUsed`, `routingReason`, `latencyMs`, `cost`, and `response` payload.
- **Unit tests** using the Node.js built-in test runner — no extra dependencies.

---

## Run locally

**Prerequisites:** [Node.js 18+](https://nodejs.org) and [MongoDB](https://www.mongodb.com/try/download/community) running locally.

```bash
npm install
npm run dev
```

- **Backend:** `http://localhost:3000`  
- **Client dashboard:** `http://localhost:5173`

The server connects to `mongodb://localhost:27017/signzy-vendor-router` by default.  
Override with the `MONGO_URI` environment variable:

```bash
MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/signzy npm run dev
```

```bash
# Run tests (no DB required — tests cover pure functions only)
npm test
```

---

## API Reference

### `GET /health`
Returns service status and registered vendor count.

```bash
curl http://localhost:3000/health
```

---

### `GET /vendors`
Lists all registered vendors.

```bash
curl http://localhost:3000/vendors
```

---

### `GET /vendors/:id`
Fetch a single vendor by ID.

```bash
curl http://localhost:3000/vendors/<vendor-id>
```

---

### `POST /vendors`
Register a new vendor. `name` and `capability` are required. All numeric fields are safely coerced.

```bash
curl -X POST http://localhost:3000/vendors \
  -H "Content-Type: application/json" \
  -d '{
    "name": "VendorD",
    "capability": "PAN_VERIFICATION",
    "weight": 40,
    "costPerRequest": 1.1,
    "timeoutMs": 2000,
    "rateLimitPerMinute": 80,
    "priority": 4,
    "supportedFeatures": ["pan-status", "name-match"],
    "baseLatencyMs": 700
  }'
```

---

### `PUT /vendors/:id`
Update an existing vendor's configuration (weight, cost, priority, etc.). Immutable fields (`id`, `createdAt`, `metrics`) are protected.

```bash
curl -X PUT http://localhost:3000/vendors/<vendor-id> \
  -H "Content-Type: application/json" \
  -d '{ "weight": 90, "costPerRequest": 0.9 }'
```

---

### `PATCH /vendors/:id/status`
Toggle a vendor UP or DOWN manually.

```bash
curl -X PATCH http://localhost:3000/vendors/<vendor-id>/status \
  -H "Content-Type: application/json" \
  -d '{ "status": "DOWN" }'
```

---

### `DELETE /vendors/:id`
Remove a vendor from the routing pool.

```bash
curl -X DELETE http://localhost:3000/vendors/<vendor-id>
```

---

### `POST /route`
The main routing endpoint. Returns a standardized response regardless of which vendor was used.

**Minimal request:**
```bash
curl -X POST http://localhost:3000/route \
  -H "Content-Type: application/json" \
  -d '{
    "capability": "PAN_VERIFICATION",
    "payload": { "pan": "ABCDE1234F", "name": "Rahul Sharma" }
  }'
```

**With requirements:**
```bash
curl -X POST http://localhost:3000/route \
  -H "Content-Type: application/json" \
  -d '{
    "capability": "PAN_VERIFICATION",
    "payload": { "pan": "ABCDE1234F", "name": "Rahul Sharma" },
    "requirements": {
      "maxLatencyMs": 2000,
      "preferLowCost": true
    }
  }'
```

**With explicit strategy:**
```bash
curl -X POST http://localhost:3000/route \
  -H "Content-Type: application/json" \
  -d '{
    "capability": "PAN_VERIFICATION",
    "payload": { "pan": "ABCDE1234F", "name": "Rahul Sharma" },
    "requirements": {
      "strategy": "round-robin",
      "requiredFeatures": ["name-match"]
    }
  }'
```

**Sample response:**
```json
{
  "status": "SUCCESS",
  "vendorUsed": "VendorC",
  "routingReason": "VendorC was selected for lowest cost (₹110).",
  "latencyMs": 1024,
  "cost": 110,
  "response": {
    "panStatus": "VALID",
    "nameMatch": true,
    "referenceId": "f7a30b7a-8fbb-4e98-b80c-c6cfd88d227b"
  }
}
```

---

### `GET /vendor-metrics`
Live metrics for all vendors: success rate, error rate, average latency, availability, and remaining rate limit.

```bash
curl http://localhost:3000/vendor-metrics
```

---

### `GET /routing-logs`
Last 200 routing decisions (newest first).

```bash
curl http://localhost:3000/routing-logs
```

---

### `GET /request-logs`
Last 200 request events (RECEIVED → SUCCESS/FAILED).

```bash
curl http://localhost:3000/request-logs
```

---

## Routing Strategies

| Strategy | Description |
|---|---|
| `weighted` | Routes based on a normalized composite score (latency 40%, success rate 30%, cost 20%, availability 10%) combined with the vendor's weight. Default strategy. |
| `priority` | Routes to the vendor with the lowest priority number first. Fallback to next on failure. |
| `lowest-latency` | Sorts by `baseLatencyMs` ascending. |
| `lowest-cost` | Sorts by `costPerRequest` ascending. Also triggered automatically when `preferLowCost: true`. |
| `failover` | Alias for priority — explicitly models a primary → secondary → tertiary fallback chain. |
| `round-robin` | Rotates across eligible vendors using a persistent per-capability counter. Counter wraps correctly across requests. |
| `feature-based` | Prefers vendors with the most supported features. Useful when `requiredFeatures` is set. |
| `health-based` | Sorts by composite health score (same formula as weighted, without the weight multiplier). |

---

## Auto-switch Conditions

The router automatically skips a vendor and tries the next one if:

- `status` is `"DOWN"` (set manually or automatically after 3 consecutive failures).
- `enabled` is `false`.
- The vendor does not support the requested `capability`.
- A required feature (`requirements.requiredFeatures`) is missing.
- `baseLatencyMs` exceeds `requirements.maxLatencyMs`.
- Requests in the last 60 seconds have hit `rateLimitPerMinute`.
- Live `errorRate` exceeds 40% (requires ≥ 5 requests for statistical confidence).

---

## MongoDB Prerequisite

A running MongoDB instance is required to persist vendor configurations and logging data.

---

## Notes

- All vendor data, routing logs, and request logs are persisted to MongoDB and survive server restarts.
- Default vendors (VendorA, VendorB, VendorC) are seeded automatically on first run if the vendor collection is empty.
- Routing logs and request logs have a 30-day TTL index — MongoDB automatically removes old entries.
- The `MONGO_URI` environment variable overrides the default `mongodb://localhost:27017/signzy-vendor-router` connection string.