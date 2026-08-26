import assert from "node:assert/strict";
import { test } from "node:test";

import { AdaptiveAdmissionController } from "../../open-sse/services/admission/controller.ts";
import { createAdaptiveAdmissionRuntime } from "../../open-sse/services/admission/runtime.ts";
import {
  ChatAdmissionController,
  releaseChatAdmissionAfterHandler,
} from "../../src/shared/middleware/chatBodyAdmission.ts";

function controller(limit: number): AdaptiveAdmissionController {
  return new AdaptiveAdmissionController({
    mode: "enforce",
    minLimit: 1,
    initialLimit: limit,
    maxLimit: limit,
    maxQueueCount: 8,
    maxQueueCost: 32,
    defaultMaxWaitMs: 5_000,
    windowMs: 60_000,
  });
}

test("preparation cost downgrades once and promotes weighted queued work", async () => {
  const admission = controller(6);
  const preparing = await admission.acquire({ cost: 5, tenantKey: "first" });
  assert.equal(preparing.status, "admitted");
  if (preparing.status !== "admitted") return;

  const waiting = await admission.acquire({ cost: 2, tenantKey: "second" });
  assert.equal(waiting.status, "queued");
  if (waiting.status !== "queued") return;

  assert.deepEqual(
    {
      activeCost: admission.snapshot().activeCost,
      preparingCost: admission.snapshot().preparingCost,
      generatingCost: admission.snapshot().generatingCost,
    },
    { activeCost: 5, preparingCost: 5, generatingCost: 0 }
  );

  preparing.lease.transitionToGeneration();
  preparing.lease.transitionToGeneration();
  const promoted = await waiting.promise;
  assert.equal(promoted.lease.cost, 2, "the queued request keeps its original weighted cost");
  assert.deepEqual(
    {
      activeCost: admission.snapshot().activeCost,
      preparingCost: admission.snapshot().preparingCost,
      preparingCount: admission.snapshot().preparingCount,
      generatingCost: admission.snapshot().generatingCost,
      generatingCount: admission.snapshot().generatingCount,
    },
    {
      activeCost: 3,
      preparingCost: 2,
      preparingCount: 1,
      generatingCost: 1,
      generatingCount: 1,
    }
  );

  preparing.lease.release();
  preparing.lease.release();
  promoted.lease.release();
  assert.equal(admission.snapshot().activeCost, 0);
  admission.shutdown();
});

test("adaptive SSE lifecycle retains only generation cost after handler preparation", async () => {
  const runtime = createAdaptiveAdmissionRuntime({
    config: {
      mode: "enforce",
      minLimit: 1,
      initialLimit: 64,
      maxLimit: 64,
      maxQueueCount: 8,
      maxQueueCost: 128,
      defaultMaxWaitMs: 5_000,
      windowMs: 60_000,
    },
    checkResourcePressure: () => null,
    getResourcePressureObservation: () => ({
      state: { severity: "normal", reason: "none", observedAtMs: 0 },
      changed: false,
    }),
  });
  const admitted = await runtime.acquire({
    tenantKey: "phase-test",
    body: {
      stream: true,
      messages: [{ role: "user", content: "x".repeat(64 * 1024) }],
      tools: [],
    },
    streaming: true,
  });
  assert.equal(admitted.status, "admitted");
  if (admitted.status !== "admitted") return;

  const preparationCost = runtime.snapshot().activeCost;
  assert.ok(preparationCost > 1, `expected weighted preparation cost, got ${preparationCost}`);

  const response = runtime.attachResponseLifecycle(
    new Response(new ReadableStream<Uint8Array>({ pull() {} }), {
      headers: { "content-type": "text/event-stream" },
    }),
    admitted.lease,
    { admittedAtMs: admitted.admittedAtMs }
  );
  const generating = runtime.snapshot();
  assert.equal(generating.preparingCost, 0);
  assert.equal(generating.preparingCount, 0);
  assert.equal(generating.generatingCost, 1);
  assert.equal(generating.generatingCount, 1);
  assert.equal(generating.activeCost, 1);

  await response.body?.cancel("done");
  assert.equal(runtime.snapshot().activeCost, 0);
  runtime.dispose();
});

test("structural preparation reservation ends when the handler yields its SSE response", async () => {
  const admission = new ChatAdmissionController(1);
  const lease = admission.tryAcquireHeavy();
  assert.ok(lease);

  const response = await releaseChatAdmissionAfterHandler(
    Promise.resolve(
      new Response(new ReadableStream<Uint8Array>({ pull() {} }), {
        headers: { "content-type": "text/event-stream" },
      })
    ),
    lease
  );

  assert.equal(
    admission.activeHeavy,
    0,
    "request-side preparation memory must not stay reserved for model generation"
  );
  await response.body?.cancel("done");
  lease.release();
  assert.equal(admission.activeHeavy, 0, "release remains exact-once after handoff");
});
