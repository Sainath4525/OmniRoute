---
title: "Admission control — memory preparation, adaptive cost, and provider concurrency"
status: active
lastUpdated: 2026-08-26
---

# Admission control — memory preparation, adaptive cost, and provider concurrency

OmniRoute has complementary process-local gates for preparation memory, weighted
adaptive cost, and provider concurrency. They share a lifecycle but do not mint
capacity for one another.

## 1. Byte-level per-connection lanes (`chatBodyAdmission.ts`)

- **Scope:** the buffered-body/heap path for `POST /v1/chat/completions`. Guards
  against heap amplification from large coding-agent bodies (#4380).
- **Gate:** **always on.** Every API key and `anonymous` contend for one process-global
  heavyweight/memory budget. Hashed connection keys select round-robin fairness queues;
  they never create per-key capacity. On a healthy process, bounded extra headroom is
  derived from initialized runtime memory telemetry unless the operator explicitly
  configures it. The provider samples during controller construction, so health does
  not remain `telemetry_unavailable` until the first admission attempt.
- **Tuning:**
  - `OMNIROUTE_CHAT_VIRTUAL_TTL_MS` and `OMNIROUTE_CHAT_VIRTUAL_MAX_SESSIONS` are
    deprecated no-ops retained for configuration compatibility; the process-global
    controller has no per-session lane map or fixed session-count ceiling
  - `OMNIROUTE_CHAT_ADMISSION_QUEUE_MS` — queue-wait before 503 (default 2000)
  - `OMNIROUTE_CHAT_ADMISSION_MAX_QUEUED_BYTES` — queued-bytes heap valve (default 4 MB)
  - `OMNIROUTE_CHAT_ADMISSION_HEALTHY_HEADROOM` — optional exact healthy-headroom override;
    when unset, runtime-derived capacity has no fixed session-count ceiling and fails back to
    the configured primary capacity (default 1) only when critical telemetry is unavailable
  - `OMNIROUTE_CHAT_ADMISSION_HEAVY_REQUEST_COST_BYTES` — bounded per-request reservation
    (default 1 GiB)
  - `OMNIROUTE_CHAT_ADMISSION_RESERVED_MEMORY_BYTES` — bounded OS/application reserve
    (default 512 MiB)
  - `OMNIROUTE_CHAT_ADMISSION_RECOVERY_STABLE_MS` — real-time recovery interval
    (default 5000 ms)
- **Derivation:** the tightest coherent V8, process-available/constrained, host-memory,
  cgroup-v1, cgroup-v2 `memory.max`, or cgroup-v2 `memory.high` budget wins. Process RSS,
  heap, external, and ArrayBuffer pressure are included without double-counting ArrayBuffers
  that are already part of `external`. Eligible provider supply can only lower the result;
  it cannot create memory capacity. The hierarchical gates merged in #11493 remain the sole
  provider/account scheduling authority.
- **Lifecycle handoff:** the full structural reservation lasts through body ingestion,
  parsing, policy, translation, and upstream-response preparation. It releases when the
  handler yields a response, before a long SSE/model-generation lifetime. The existing
  adaptive controller then retains only its configured lightweight streaming-generation
  cost, while #11493's global/provider/account semaphore remains held until the stream
  drains or is cancelled.
- **Reports:** the management-protected full `GET /api/monitoring/health` view exposes
  process-global active/available counts, calculated capacity, configured/effective headroom,
  telemetry availability, the exact limiter, and every valid considered byte budget. Cgroup
  paths, credentials, account identities, and request details are never included; anonymous
  health remains liveness-only.

## 2. Adaptive runtime virtual lanes (`open-sse/services/admission`)

- **Scope:** tenant-key admission for provider dispatch — queue cost, latency-guided
  limit adaptation, lane queueing, and lane metrics.
- **Gate:** **opt-in.** Disabled unless `OMNIROUTE_CHAT_VIRTUAL_LANES=true`. Without it,
  the adaptive controller keeps the shared queue behavior (criterion 1 of #9654 only
  holds once an operator enables lanes).
- **Tuning:** `OMNIROUTE_CHAT_VIRTUAL_LANES` + adaptive config (`maxQueueCount`,
  `maxQueueCost`, `defaultMaxWaitMs`, …).
- **Reports:** the management-protected health view exposes the allowlisted shared limit,
  active/queued cost, preparation/generation cost and count, pressure, and aggregate
  outcome counters. Tenant keys and queue items remain excluded from this projection.

## 3. Hierarchical provider concurrency (#11493)

Immediately before `withRateLimit`, `chatCore` atomically acquires the applicable
global, provider, and account gates through `accountSemaphore.acquireMany()`. Waiting
holds no partial parent reservation; queue depth, timeout, cancellation, account
rotation, and exact-once composite release stay owned by that scheduler. Streaming
holds the composite gate through drain or cancellation. Runtime memory and eligible
provider counts may lower upstream admission, but neither creates permits in this
scheduler.

## 4. Fan-out probes — per-target admission for combo/fusion (#9654 Wave 2)

Combo (priority / round-robin) and fusion fan out N model targets under one parent
request. Since #9654 Wave 2, **each fan-out target is gated before dispatch** by a
per-target probe (`PerTargetAdmissionHook`, built by `createPerTargetAdmissionHook`)
against the **parent's** tenant lane.

- **Scope:** every fan-out target dispatched by combo, fusion, and the chaos engine.
  System 1 (byte-level) is unaffected — it never probes fan-out targets.
- **Gate:** **opt-in with system 2.** A no-op when `OMNIROUTE_CHAT_VIRTUAL_LANES`
  is unset — the parent request already holds the shared-queue lease in that mode,
  so probing would double-count and reject combo targets.
- **Semantics:**
  - **Strictly non-blocking — skip, never queue.** `maxWaitMs 0`: a full lane
    skips the target and the combo's fallback machinery (or fusion's survivor
    panel) serves instead. This is deliberate: a fan-out target is redundant
    work, and queueing it piles more load onto the exact congestion lanes exist
    to stop. `defaultMaxWaitMs` therefore applies to the **parent request only**;
    fan-out probes never wait, and there is intentionally **no knob** to make
    them wait (issue history shows wait knobs produced the mass-502/504 class
    #9654 prevents — revisit only if an operator reports skipped fan-out targets
    hurting response quality).
  - **Release-on-admit.** An admitted probe releases its lease immediately: it is
    a capacity gate, not a hold. The parent's lease covers the fan-out; holding N
    more would inflate shared active cost and reject other tenants. Best-effort,
    not a reservation: the lane can refill between probe and dispatch, so under
    heavy contention the gate may admit into a lane that is full again by the
    time the target dispatches.
  - **Priced from the real fan-out body.** The probe estimates cost from the
    target's actual body — including the request class derived from its `stream`
    flag, exactly like the parent path — so fusion panel members (`stream: false`)
    are priced at the non-streaming class they will truly occupy, and priority/RR
    targets at whatever the user requested.
- **Reports:** a probe skip after the first target bumps combo's per-request
  `fallbackCount` (mirroring the existing fallback semantics; visible in combo
  logs); fusion returns 503 when every panel member is skipped. There is
  **no aggregate counter** (e.g. `virtualFanoutSkipped`) on the snapshot today —
  if an operator reports they cannot tell how often the lane gate skips fan-out
  targets, that is the trigger to add one.

## Which one is showing in a dashboard

- `chatAdmission` → process-global structural preparation memory and queue state.
- `adaptiveAdmission` → allowlisted weighted controller limits, phase costs, queue
  aggregates, and pressure state. Per-tenant lane identities are intentionally absent.

## Why both exist

The byte-level lanes bound the memory-heavy parse/compress path; the adaptive lanes
bound dispatch cost per tenant. #9654's criterion 1 ("one session's burst does not 503
another") is enforced by system 1 unconditionally and by system 2 once opt-in is enabled.
