import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveStandaloneHeapConfiguration } from "../../scripts/build/runtime-env.mjs";
import {
  createRuntimeHeavyHeadroomPolicy,
  type RuntimeMemoryTelemetry,
} from "../../src/shared/middleware/chatAdmissionHeadroom.ts";
import {
  PerConnectionAdmissionController,
  admitChatStructure,
} from "../../src/shared/middleware/chatBodyAdmission.ts";

const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;

function heavyBody() {
  return {
    messages: Array.from({ length: 200 }, () => ({ role: "user", content: "x" })),
    tools: [],
  };
}

function policy(sample: () => RuntimeMemoryTelemetry) {
  return createRuntimeHeavyHeadroomPolicy({
    explicitHeadroom: null,
    baseCapacity: 1,
    legacyHeadroom: 1,
    shedRatio: 0.75,
    sample,
  });
}

test("official automatic startup and initialized runtime telemetry admit calculated large-host capacity", async () => {
  const startup = resolveStandaloneHeapConfiguration(
    {},
    {
      hostTotalBytes: 62115 * MiB,
      hostFreeBytes: 51200 * MiB,
      processAvailableBytes: 51200 * MiB,
      processConstrainedBytes: null,
      rssUsedBytes: 856 * MiB,
      cgroupVersion: null,
      cgroupLimitBytes: null,
      cgroupUsedBytes: null,
    }
  );
  const runtime = policy(() => ({
    heapLimitBytes: startup.maxOldSpaceMb * MiB,
    heapUsedBytes: 512 * MiB,
    rssUsedBytes: 856 * MiB,
    externalBytes: 256 * MiB,
    arrayBuffersBytes: 192 * MiB,
    processAvailableBytes: 51200 * MiB,
    processConstrainedBytes: null,
    hostTotalBytes: 62115 * MiB,
    hostFreeBytes: 51200 * MiB,
    cgroupVersion: null,
    cgroupLimitBytes: null,
    cgroupUsedBytes: null,
  }));
  const admission = new PerConnectionAdmissionController(1, {
    healthyHeadroomPolicy: runtime,
    onShed: () => {},
  });
  const snapshot = admission.snapshot();
  const leases = [];

  assert.equal(startup.source, "automatic");
  assert.ok(startup.maxOldSpaceMb > 1024);
  assert.equal(snapshot.telemetryAvailability, "available");
  assert.ok(snapshot.effectiveHealthyHeadroom >= 2);
  assert.ok(snapshot.calculatedTotalHeavyCapacity >= 3);
  for (let index = 0; index < snapshot.calculatedTotalHeavyCapacity; index += 1) {
    const result = await admitChatStructure(heavyBody(), null, {
      controller: admission.getController(`large-${index}`),
      heapPressureCheck: () => false,
    });
    assert.equal(result.admit, true);
    if (result.admit && result.lease) leases.push(result.lease);
  }
  assert.equal(admission.snapshot().activeHeavyTotal, snapshot.calculatedTotalHeavyCapacity);
  for (const lease of leases) lease.release();
  assert.equal(admission.snapshot().activeHeavyTotal, 0);
});

test("cgroup-constrained startup and runtime both contract on a large physical host", () => {
  const startup = resolveStandaloneHeapConfiguration(
    {},
    {
      hostTotalBytes: 62 * GiB,
      hostFreeBytes: 50 * GiB,
      processAvailableBytes: 700 * MiB,
      processConstrainedBytes: GiB,
      rssUsedBytes: 64 * MiB,
      cgroupVersion: "v2",
      cgroupLimitBytes: GiB,
      cgroupUsedBytes: 324 * MiB,
    }
  );
  const runtime = policy(() => ({
    heapLimitBytes: startup.maxOldSpaceMb * MiB,
    heapUsedBytes: 128 * MiB,
    rssUsedBytes: 324 * MiB,
    externalBytes: 64 * MiB,
    arrayBuffersBytes: 32 * MiB,
    processAvailableBytes: 700 * MiB,
    processConstrainedBytes: GiB,
    hostTotalBytes: 62 * GiB,
    hostFreeBytes: 50 * GiB,
    cgroupVersion: "v2",
    cgroupLimitBytes: GiB,
    cgroupUsedBytes: 324 * MiB,
  }));

  assert.ok(startup.maxOldSpaceMb < 512);
  assert.equal(runtime.snapshot().effectiveHeadroom, 0);
  assert.equal(runtime.snapshot().calculatedTotalCapacity, 1);
  assert.match(runtime.snapshot().reason, /(?:v8_heap|cgroup_v2)_/);
});
