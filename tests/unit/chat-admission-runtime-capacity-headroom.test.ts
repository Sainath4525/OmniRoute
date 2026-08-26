import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import {
  DEFAULT_HEAVY_REQUEST_COST_BYTES,
  DEFAULT_RECOVERY_STABLE_MS,
  DEFAULT_RESERVED_MEMORY_BYTES,
  createRuntimeHeavyHeadroomPolicy,
  resolveRuntimeHeavyHeadroomConfiguration,
  type RuntimeMemoryTelemetry,
} from "../../src/shared/middleware/chatAdmissionHeadroom.ts";
import {
  ChatAdmissionController,
  PerConnectionAdmissionController,
  admitChatStructure,
} from "../../src/shared/middleware/chatBodyAdmission.ts";

const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;

function telemetry(overrides: Partial<RuntimeMemoryTelemetry> = {}): RuntimeMemoryTelemetry {
  return {
    heapLimitBytes: 16 * GiB,
    heapUsedBytes: 512 * MiB,
    rssUsedBytes: 856 * MiB,
    externalBytes: 256 * MiB,
    arrayBuffersBytes: 192 * MiB,
    processAvailableBytes: 50 * GiB,
    processConstrainedBytes: null,
    hostTotalBytes: 62 * GiB,
    hostFreeBytes: 50 * GiB,
    cgroupVersion: null,
    cgroupLimitBytes: null,
    cgroupUsedBytes: null,
    ...overrides,
  };
}

function heavyBody() {
  return {
    messages: Array.from({ length: 200 }, () => ({ role: "user", content: "x" })),
    tools: [],
  };
}

function policyFor(
  sample: () => RuntimeMemoryTelemetry,
  options: { now?: () => number; recoveryStableMs?: number } = {}
) {
  return createRuntimeHeavyHeadroomPolicy({
    explicitHeadroom: null,
    baseCapacity: 1,
    legacyHeadroom: 1,
    shedRatio: 0.75,
    sample,
    now: options.now,
    recoveryStableMs: options.recoveryStableMs,
  });
}

function readProductionAdmissionSnapshot(overrides: Record<string, string>) {
  const script = `
    const { perConnectionAdmissionController } = await import(
      "./src/shared/middleware/chatBodyAdmission.ts"
    );
    console.log("HEADROOM=" + JSON.stringify(perConnectionAdmissionController.snapshot()));
  `;
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx/esm", "--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: "test",
        APP_LOG_TO_FILE: "false",
        DATA_DIR: "/tmp/omniroute-admission-runtime-headroom-test",
        ...overrides,
      },
    }
  );
  const match = output.match(/^HEADROOM=(.+)$/m);
  assert.ok(match, "child process must report the production admission snapshot");
  return JSON.parse(match[1]);
}

test("adaptive cost, reserve, and recovery settings are bounded", () => {
  assert.equal(DEFAULT_HEAVY_REQUEST_COST_BYTES, GiB);
  assert.equal(DEFAULT_RESERVED_MEMORY_BYTES, 512 * MiB);
  assert.equal(DEFAULT_RECOVERY_STABLE_MS, 5_000);
  assert.deepEqual(resolveRuntimeHeavyHeadroomConfiguration({}), {
    perRequestCostBytes: GiB,
    reservedMemoryBytes: 512 * MiB,
    recoveryStableMs: 5_000,
    valid: true,
  });
  assert.deepEqual(
    resolveRuntimeHeavyHeadroomConfiguration({
      heavyRequestCostBytes: String(2 * GiB),
      reservedMemoryBytes: String(GiB),
      recoveryStableMs: "12000",
    }),
    {
      perRequestCostBytes: 2 * GiB,
      reservedMemoryBytes: GiB,
      recoveryStableMs: 12_000,
      valid: true,
    }
  );

  for (const invalid of ["", "1", String(64 * MiB), "536870912junk", "Infinity"]) {
    assert.equal(
      resolveRuntimeHeavyHeadroomConfiguration({ reservedMemoryBytes: invalid }).valid,
      false
    );
  }
});

test("explicit operator headroom retains exact precedence and bypasses telemetry", () => {
  let samples = 0;
  const policy = createRuntimeHeavyHeadroomPolicy({
    explicitHeadroom: 5,
    baseCapacity: 1,
    legacyHeadroom: 1,
    shedRatio: 0.75,
    sample: () => {
      samples += 1;
      return telemetry({ heapUsedBytes: 15 * GiB });
    },
  });

  assert.equal(policy.getEffectiveHeadroom(), 5);
  assert.equal(samples, 0);
  assert.deepEqual(policy.snapshot(), {
    configuredHeadroom: 5,
    effectiveHeadroom: 5,
    calculatedTotalCapacity: 6,
    memorySafeTotalCapacity: 6,
    totalCapacity: 6,
    memorySafeHeadroom: 5,
    reason: "environment_override",
    limitingBudget: null,
    consideredBudgets: [],
    telemetryAvailability: "override",
    eligibleSupplyCapacity: null,
  });

  const production = readProductionAdmissionSnapshot({
    OMNIROUTE_CHAT_ADMISSION_HEALTHY_HEADROOM: "5",
  });
  assert.equal(production.configuredHealthyHeadroom, 5);
  assert.equal(production.effectiveHealthyHeadroom, 5);
  assert.equal(production.telemetryAvailability, "override");
});

test("invalid operator adaptive settings fail to the observable conservative configuration", () => {
  const production = readProductionAdmissionSnapshot({
    OMNIROUTE_CHAT_ADMISSION_RESERVED_MEMORY_BYTES: "1",
  });

  assert.equal(production.configuredHealthyHeadroom, null);
  assert.equal(production.effectiveHealthyHeadroom, 1);
  assert.equal(production.healthyHeadroomReason, "configuration_invalid");
  assert.equal(production.telemetryAvailability, "configuration_invalid");
});

test("the real provider is initialized before the first request and monitoring read", () => {
  const production = readProductionAdmissionSnapshot({
    NODE_OPTIONS: "--max-old-space-size=8192",
  });

  assert.notEqual(production.telemetryAvailability, "unavailable");
  assert.notEqual(production.healthyHeadroomReason, "telemetry_unavailable");
  assert.ok(production.consideredMemoryBudgets.length > 0);
  assert.equal(production.consideredMemoryBudgets[0].name, "v8_heap");
});

test("policy construction eagerly initializes the provider", () => {
  let samples = 0;
  const policy = policyFor(() => {
    samples += 1;
    return telemetry();
  });

  assert.equal(samples, 1, "constructor must initialize telemetry before any request");
  assert.ok(policy.getEffectiveHeadroom() >= 2);
  assert.equal(samples, 2);
});

test("runtime capacity has no fixed production session ceiling", () => {
  const policy = policyFor(() =>
    telemetry({
      heapLimitBytes: 64 * GiB,
      heapUsedBytes: GiB,
      rssUsedBytes: 2 * GiB,
      externalBytes: 512 * MiB,
      arrayBuffersBytes: 256 * MiB,
      processAvailableBytes: 100 * GiB,
      hostTotalBytes: 128 * GiB,
      hostFreeBytes: 100 * GiB,
    })
  );
  const snapshot = policy.snapshot();

  assert.ok(snapshot.effectiveHeadroom > 8, String(snapshot.effectiveHeadroom));
  assert.equal(snapshot.calculatedTotalCapacity, snapshot.effectiveHeadroom + 1);
});

test("the measured large-host profile derives and admits its calculated capacity", async () => {
  const policy = policyFor(() => telemetry());
  const admission = new PerConnectionAdmissionController(1, {
    healthyHeadroomPolicy: policy,
    onShed: () => {},
  });
  const calculated = admission.snapshot().calculatedTotalHeavyCapacity;
  const leases = [];

  assert.ok(calculated >= 3, `measured profile calculated only ${calculated}`);
  for (let index = 0; index < calculated; index += 1) {
    const result = await admitChatStructure(heavyBody(), null, {
      controller: admission.getController(`measured-${index}`),
      heapPressureCheck: () => false,
    });
    assert.equal(result.admit, true, `calculated slot ${index + 1} must admit`);
    if (result.admit && result.lease) leases.push(result.lease);
  }
  const exhausted = await admitChatStructure(heavyBody(), null, {
    controller: admission.getController("measured-exhausted"),
    heapPressureCheck: () => false,
  });
  assert.equal(exhausted.admit, false);
  if (!exhausted.admit) {
    assert.equal(exhausted.response.status, 503);
    assert.equal(exhausted.response.headers.get("Retry-After"), "1");
  }
  assert.equal(admission.snapshot().activeHeavyTotal, calculated);
  assert.equal(admission.snapshot().availableHeavySlots, 0);

  for (const lease of leases) {
    lease.release();
    lease.release();
  }
  assert.equal(admission.snapshot().activeHeavyTotal, 0, "release is exact-once");
});

test("pressure contracts immediately without revoking existing sessions", async () => {
  let current = telemetry();
  const policy = policyFor(() => current);
  const admission = new PerConnectionAdmissionController(1, {
    healthyHeadroomPolicy: policy,
    onShed: () => {},
  });
  const leases = [];

  for (let index = 0; index < 3; index += 1) {
    const result = await admitChatStructure(heavyBody(), null, {
      controller: admission.getController(`pressure-${index}`),
      heapPressureCheck: () => false,
    });
    assert.equal(result.admit, true);
    if (result.admit && result.lease) leases.push(result.lease);
  }
  current = telemetry({ heapUsedBytes: 15 * GiB });
  assert.equal(policy.getEffectiveHeadroom(), 0);
  assert.equal(admission.snapshot().activeHeavyTotal, 3, "contraction must not kill leases");
  assert.equal(admission.snapshot().availableHeavySlots, 0);

  const rejected = await admitChatStructure(heavyBody(), null, {
    controller: admission.getController("pressure-new"),
    heapPressureCheck: () => true,
  });
  assert.equal(rejected.admit, false, "only new heavy work is shed");
  for (const lease of leases) lease.release();
});

test("recovery requires a real stable elapsed interval", () => {
  let current = telemetry({ heapUsedBytes: 15 * GiB });
  let now = 40_000;
  const policy = policyFor(() => current, { now: () => now, recoveryStableMs: 1_000 });

  assert.equal(policy.getEffectiveHeadroom(), 0);
  current = telemetry();
  for (let index = 0; index < 100; index += 1) {
    assert.equal(policy.getEffectiveHeadroom(), 0);
  }
  assert.equal(policy.snapshot().reason, "recovery_hysteresis");
  now += 999;
  assert.equal(policy.getEffectiveHeadroom(), 0);
  now += 1;
  assert.ok(policy.getEffectiveHeadroom() >= 2);
});

test("concurrent acquisitions are atomic and idle session labels consume no capacity", async () => {
  const policy = policyFor(() => telemetry({ heapLimitBytes: 4 * GiB }));
  const admission = new PerConnectionAdmissionController(1, {
    healthyHeadroomPolicy: policy,
    onShed: () => {},
  });
  for (let index = 0; index < 1_000; index += 1) {
    admission.getController(`idle-${index}`);
  }
  assert.equal(admission.snapshot().activeHeavyTotal, 0);

  const calculated = admission.snapshot().calculatedTotalHeavyCapacity;
  const results = await Promise.all(
    Array.from({ length: calculated }, (_, index) =>
      admitChatStructure(heavyBody(), null, {
        controller: admission.getController(`concurrent-${index}`),
        heapPressureCheck: () => false,
      })
    )
  );
  assert.equal(results.filter((result) => result.admit).length, calculated);
  assert.equal(admission.snapshot().activeHeavyTotal, calculated);
  for (const result of results) if (result.admit) result.lease?.release();
  assert.equal(admission.snapshot().activeHeavyTotal, 0);
});

test("cancellation and timeout leave no queued bytes or leaked capacity", async () => {
  const controller = new ChatAdmissionController(1, 1024, 0, () => {});
  const held = controller.tryAcquireHeavy();
  assert.ok(held);

  const abortController = new AbortController();
  const cancelled = controller.acquireHeavyWithin(2_000, abortController.signal, 400, "cancel");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(controller.waitingCount, 1);
  abortController.abort();
  assert.equal(await cancelled, null);
  assert.equal(controller.queuedBytes, 0);
  assert.equal(controller.shedTotal, 0);

  const timedOut = await controller.acquireHeavyWithin(10, undefined, 400, "timeout");
  assert.equal(timedOut, null);
  assert.equal(controller.queuedBytes, 0);
  assert.equal(controller.waitingCount, 0);
  assert.equal(controller.shedTotal, 1);
  held.release();
  held.release();
  assert.equal(controller.activeHeavy, 0);
});

test("unavailable telemetry never claims adaptive capacity", () => {
  const empty: RuntimeMemoryTelemetry = {
    heapLimitBytes: null,
    heapUsedBytes: null,
    rssUsedBytes: null,
    externalBytes: null,
    arrayBuffersBytes: null,
    processAvailableBytes: null,
    processConstrainedBytes: null,
    hostTotalBytes: null,
    hostFreeBytes: null,
    cgroupVersion: null,
    cgroupLimitBytes: null,
    cgroupUsedBytes: null,
  };
  const policy = policyFor(() => empty);
  const snapshot = policy.snapshot();

  assert.equal(snapshot.effectiveHeadroom, 1);
  assert.equal(snapshot.reason, "telemetry_unavailable");
  assert.equal(snapshot.telemetryAvailability, "unavailable");
  assert.equal(snapshot.limitingBudget, null);
  assert.deepEqual(snapshot.consideredBudgets, []);
});
