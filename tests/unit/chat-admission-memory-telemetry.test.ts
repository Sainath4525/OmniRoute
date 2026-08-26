import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deriveRuntimeHeavyCapacity,
  sampleRuntimeMemoryTelemetry,
  type RuntimeHeavyCapacityInput,
  type RuntimeMemoryTelemetry,
} from "../../src/shared/middleware/chatAdmissionHeadroom.ts";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

function profile(overrides: Partial<RuntimeMemoryTelemetry> = {}): RuntimeMemoryTelemetry {
  return {
    heapLimitBytes: 4 * GiB,
    heapUsedBytes: 512 * MiB,
    rssUsedBytes: 768 * MiB,
    externalBytes: 192 * MiB,
    arrayBuffersBytes: 128 * MiB,
    processAvailableBytes: 6 * GiB,
    processConstrainedBytes: 8 * GiB,
    hostTotalBytes: 16 * GiB,
    hostFreeBytes: 12 * GiB,
    cgroupVersion: null,
    cgroupLimitBytes: null,
    cgroupUsedBytes: null,
    ...overrides,
  };
}

function input(
  telemetry: RuntimeMemoryTelemetry,
  overrides: Partial<RuntimeHeavyCapacityInput> = {}
): RuntimeHeavyCapacityInput {
  return {
    ...telemetry,
    baseCapacity: 1,
    legacyHeadroom: 1,
    shedRatio: 0.75,
    perRequestCostBytes: GiB,
    reservedMemoryBytes: 512 * MiB,
    eligibleSupplyCapacity: null,
    ...overrides,
  };
}

function expectedCapacity(source: RuntimeMemoryTelemetry): number {
  const reserve = 512 * MiB;
  const footprint = Math.max(
    source.rssUsedBytes ?? 0,
    (source.heapUsedBytes ?? 0) + Math.max(source.externalBytes ?? 0, source.arrayBuffersBytes ?? 0)
  );
  const available = [
    Math.floor((source.heapLimitBytes ?? 0) * 0.75) - (source.heapUsedBytes ?? 0) - reserve,
    Math.floor((source.processAvailableBytes ?? 0) * 0.75) - reserve,
    Math.floor((source.hostTotalBytes ?? 0) * 0.75) -
      Math.max((source.hostTotalBytes ?? 0) - (source.hostFreeBytes ?? 0), footprint) -
      reserve,
  ];
  if (source.processConstrainedBytes && source.processAvailableBytes) {
    available.push(
      Math.floor(source.processConstrainedBytes * 0.75) -
        Math.max(source.processConstrainedBytes - source.processAvailableBytes, footprint) -
        reserve
    );
  }
  if (source.cgroupLimitBytes && source.cgroupUsedBytes !== null) {
    available.push(
      Math.floor(source.cgroupLimitBytes * 0.75) -
        Math.max(source.cgroupUsedBytes, footprint) -
        reserve
    );
  }
  return Math.max(0, Math.floor(Math.min(...available) / GiB));
}

for (const scenario of [
  {
    name: "small-memory machine",
    telemetry: profile({
      heapLimitBytes: 768 * MiB,
      heapUsedBytes: 128 * MiB,
      rssUsedBytes: 256 * MiB,
      externalBytes: 64 * MiB,
      arrayBuffersBytes: 32 * MiB,
      processAvailableBytes: 640 * MiB,
      processConstrainedBytes: GiB,
      hostTotalBytes: 2 * GiB,
      hostFreeBytes: GiB,
    }),
  },
  {
    name: "medium-memory machine",
    telemetry: profile(),
  },
  {
    name: "large-memory machine",
    telemetry: profile({
      heapLimitBytes: 16 * GiB,
      heapUsedBytes: 512 * MiB,
      rssUsedBytes: 856 * MiB,
      externalBytes: 256 * MiB,
      arrayBuffersBytes: 192 * MiB,
      processAvailableBytes: 50 * GiB,
      processConstrainedBytes: null,
      hostTotalBytes: 62 * GiB,
      hostFreeBytes: 50 * GiB,
    }),
  },
]) {
  test(`capacity is calculated from the supplied ${scenario.name} profile`, () => {
    const expectedTotal = Math.max(1, expectedCapacity(scenario.telemetry));
    const result = deriveRuntimeHeavyCapacity(input(scenario.telemetry));

    assert.equal(result.totalCapacity, expectedTotal);
    assert.equal(result.memorySafeHeadroom, Math.max(0, expectedTotal - 1));
    assert.equal(result.totalCapacity, result.memorySafeHeadroom + 1);
  });
}

test("cgroup v2 discovery pairs the real container limit and current usage", () => {
  const files = new Map<string, string>([
    ["/proc/self/cgroup", "0::/docker/abc\n"],
    [
      "/proc/self/mountinfo",
      "29 23 0:26 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw\n",
    ],
    ["/sys/fs/cgroup/docker/abc/memory.max", String(3 * GiB)],
    ["/sys/fs/cgroup/docker/abc/memory.current", String(768 * MiB)],
    ["/sys/fs/cgroup/docker/abc/memory.high", String(2 * GiB)],
  ]);
  const sample = sampleRuntimeMemoryTelemetry({
    readText: (filePath) => files.get(filePath) ?? null,
    heapStatistics: () => ({ heap_size_limit: 2 * GiB, used_heap_size: 256 * MiB }),
    memoryUsage: () => ({
      rss: 512 * MiB,
      heapTotal: 384 * MiB,
      heapUsed: 256 * MiB,
      external: 96 * MiB,
      arrayBuffers: 64 * MiB,
    }),
    availableMemory: () => 2 * GiB,
    constrainedMemory: () => 3 * GiB,
    hostTotalMemory: () => 16 * GiB,
    hostFreeMemory: () => 12 * GiB,
  });

  assert.equal(sample.cgroupVersion, "v2");
  assert.equal(sample.cgroupLimitBytes, 3 * GiB);
  assert.equal(sample.cgroupUsedBytes, 768 * MiB);
  assert.equal(sample.cgroupHighBytes, 2 * GiB);
  const capacity = deriveRuntimeHeavyCapacity(input(sample));
  assert.ok(capacity.consideredBudgets.some((budget) => budget.name === "cgroup_v2_high"));
});

test("cgroup v2 memory.high contracts headroom while usage is above the soft throttle", () => {
  const capacity = deriveRuntimeHeavyCapacity(
    input(
      profile({
        heapLimitBytes: 16 * GiB,
        processAvailableBytes: 12 * GiB,
        processConstrainedBytes: 16 * GiB,
        hostTotalBytes: 32 * GiB,
        hostFreeBytes: 24 * GiB,
        cgroupVersion: "v2",
        cgroupLimitBytes: 8 * GiB,
        cgroupUsedBytes: 3 * GiB,
        cgroupHighBytes: 2 * GiB,
      })
    )
  );

  assert.equal(capacity.totalCapacity, 1);
  assert.equal(capacity.memorySafeHeadroom, 0);
  assert.equal(capacity.limitingBudget, "cgroup_v2_high");
  assert.equal(capacity.reason, "cgroup_v2_high_pressure");
  assert.equal(
    capacity.consideredBudgets.find((budget) => budget.name === "cgroup_v2_high")?.availableBytes,
    0
  );
});

test("cgroup v1 discovery resolves the memory controller mount and usage", () => {
  const files = new Map<string, string>([
    ["/proc/self/cgroup", "5:memory:/docker/legacy\n"],
    [
      "/proc/self/mountinfo",
      "31 23 0:27 / /sys/fs/cgroup/memory rw,relatime - cgroup cgroup rw,memory\n",
    ],
    ["/sys/fs/cgroup/memory/docker/legacy/memory.limit_in_bytes", String(2 * GiB)],
    ["/sys/fs/cgroup/memory/docker/legacy/memory.usage_in_bytes", String(512 * MiB)],
  ]);
  const sample = sampleRuntimeMemoryTelemetry({
    readText: (filePath) => files.get(filePath) ?? null,
    heapStatistics: () => ({ heap_size_limit: GiB, used_heap_size: 128 * MiB }),
    memoryUsage: () => ({
      rss: 256 * MiB,
      heapTotal: 192 * MiB,
      heapUsed: 128 * MiB,
      external: 48 * MiB,
      arrayBuffers: 32 * MiB,
    }),
    availableMemory: () => 1536 * MiB,
    constrainedMemory: () => 2 * GiB,
    hostTotalMemory: () => 16 * GiB,
    hostFreeMemory: () => 12 * GiB,
  });

  assert.equal(sample.cgroupVersion, "v1");
  assert.equal(sample.cgroupLimitBytes, 2 * GiB);
  assert.equal(sample.cgroupUsedBytes, 512 * MiB);
});

test("unlimited cgroups and Node sentinels do not become finite budgets", () => {
  const files = new Map<string, string>([
    ["/proc/self/cgroup", "0::/\n"],
    ["/proc/self/mountinfo", "29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n"],
    ["/sys/fs/cgroup/memory.max", "max\n"],
    ["/sys/fs/cgroup/memory.current", String(512 * MiB)],
  ]);
  const sample = sampleRuntimeMemoryTelemetry({
    readText: (filePath) => files.get(filePath) ?? null,
    heapStatistics: () => ({ heap_size_limit: 8 * GiB, used_heap_size: 512 * MiB }),
    memoryUsage: () => ({
      rss: 768 * MiB,
      heapTotal: 640 * MiB,
      heapUsed: 512 * MiB,
      external: 128 * MiB,
      arrayBuffers: 64 * MiB,
    }),
    availableMemory: () => 12 * GiB,
    constrainedMemory: () => 18_446_744_073_709_552_000,
    hostTotalMemory: () => 16 * GiB,
    hostFreeMemory: () => 12 * GiB,
  });

  assert.equal(sample.cgroupVersion, null);
  assert.equal(sample.cgroupLimitBytes, null);
  assert.equal(sample.cgroupUsedBytes, null);
  assert.equal(sample.processConstrainedBytes, null);
  assert.ok(deriveRuntimeHeavyCapacity(input(sample)).memorySafeHeadroom > 0);
});

test("the cgroup v1 unlimited sentinel is not treated as a host-sized container budget", () => {
  const files = new Map<string, string>([
    ["/proc/self/cgroup", "5:memory:/docker/legacy\n"],
    ["/proc/self/mountinfo", "31 23 0:27 / /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory\n"],
    ["/sys/fs/cgroup/memory/docker/legacy/memory.limit_in_bytes", "9223372036854771712\n"],
    ["/sys/fs/cgroup/memory/docker/legacy/memory.usage_in_bytes", String(512 * MiB)],
  ]);
  const sample = sampleRuntimeMemoryTelemetry({
    readText: (filePath) => files.get(filePath) ?? null,
    heapStatistics: () => ({ heap_size_limit: 8 * GiB, used_heap_size: 512 * MiB }),
    memoryUsage: () => ({
      rss: 768 * MiB,
      heapTotal: 640 * MiB,
      heapUsed: 512 * MiB,
      external: 128 * MiB,
      arrayBuffers: 64 * MiB,
    }),
    availableMemory: () => 12 * GiB,
    constrainedMemory: () => undefined,
    hostTotalMemory: () => 16 * GiB,
    hostFreeMemory: () => 12 * GiB,
  });

  assert.equal(sample.cgroupVersion, null);
  assert.equal(sample.cgroupLimitBytes, null);
  assert.equal(sample.cgroupUsedBytes, null);
});

test("bare-metal Windows and macOS fall back to portable Node, V8, and host signals", () => {
  const sample = sampleRuntimeMemoryTelemetry({
    readText: () => null,
    heapStatistics: () => ({ heap_size_limit: 4 * GiB, used_heap_size: 512 * MiB }),
    memoryUsage: () => ({
      rss: 768 * MiB,
      heapTotal: 640 * MiB,
      heapUsed: 512 * MiB,
      external: 192 * MiB,
      arrayBuffers: 128 * MiB,
    }),
    availableMemory: () => undefined,
    constrainedMemory: () => undefined,
    hostTotalMemory: () => 16 * GiB,
    hostFreeMemory: () => 12 * GiB,
  });

  assert.equal(sample.cgroupVersion, null);
  assert.equal(sample.cgroupLimitBytes, null);
  assert.equal(sample.processAvailableBytes, null);
  assert.equal(sample.processConstrainedBytes, null);
  const capacity = deriveRuntimeHeavyCapacity(input(sample));
  assert.equal(capacity.telemetryAvailability, "available");
  assert.deepEqual(
    capacity.consideredBudgets.map((budget) => budget.name),
    ["v8_heap", "host_memory"]
  );
  assert.ok(capacity.memorySafeHeadroom > 0);
});

for (const version of ["v1", "v2"] as const) {
  test(`a finite cgroup ${version} budget safely limits a larger host`, () => {
    const result = deriveRuntimeHeavyCapacity(
      input(
        profile({
          cgroupVersion: version,
          cgroupLimitBytes: 2 * GiB,
          cgroupUsedBytes: 512 * MiB,
          processAvailableBytes: 1536 * MiB,
          processConstrainedBytes: 2 * GiB,
          hostTotalBytes: 62 * GiB,
          hostFreeBytes: 50 * GiB,
        })
      )
    );

    assert.equal(result.totalCapacity, 1);
    assert.equal(result.memorySafeHeadroom, 0);
    assert.ok(result.consideredBudgets.some((budget) => budget.name === `cgroup_${version}`));
    assert.equal(result.limitingBudget, "process_constrained");
  });
}

test("invalid optional telemetry is ignored while critical telemetry fails closed", () => {
  const optionalInvalid = deriveRuntimeHeavyCapacity(
    input(
      profile({
        hostTotalBytes: Number.POSITIVE_INFINITY,
        hostFreeBytes: Number.MAX_SAFE_INTEGER,
        processConstrainedBytes: Number.MAX_SAFE_INTEGER,
        cgroupVersion: "v2",
        cgroupLimitBytes: 2 * GiB,
        cgroupUsedBytes: 3 * GiB,
      })
    )
  );
  assert.ok(optionalInvalid.memorySafeHeadroom > 0);
  assert.equal(optionalInvalid.telemetryAvailability, "partial");
  assert.deepEqual(
    optionalInvalid.consideredBudgets.map((budget) => budget.name),
    ["v8_heap", "process_available"]
  );

  for (const critical of [
    profile({ heapLimitBytes: Number.NaN }),
    profile({ heapUsedBytes: 8 * GiB, heapLimitBytes: 4 * GiB }),
    profile({ rssUsedBytes: Number.POSITIVE_INFINITY }),
    profile({ externalBytes: -1 }),
    profile({ arrayBuffersBytes: null }),
  ]) {
    const result = deriveRuntimeHeavyCapacity(input(critical));
    assert.equal(result.memorySafeHeadroom, 1);
    assert.equal(result.totalCapacity, 2);
    assert.notEqual(result.telemetryAvailability, "available");
  }
});

test("eligible provider supply caps memory-derived capacity but cannot create it", () => {
  const abundantMemory = input(profile({ heapLimitBytes: 16 * GiB }), {
    eligibleSupplyCapacity: 2,
  });
  const scarceMemory = input(profile({ heapLimitBytes: 2 * GiB }), {
    eligibleSupplyCapacity: 100,
  });
  const uncappedScarce = deriveRuntimeHeavyCapacity({
    ...scarceMemory,
    eligibleSupplyCapacity: null,
  });

  assert.equal(deriveRuntimeHeavyCapacity(abundantMemory).totalCapacity, 2);
  assert.equal(
    deriveRuntimeHeavyCapacity(scarceMemory).totalCapacity,
    uncappedScarce.totalCapacity
  );
});

test("genuinely unavailable telemetry reports fallback, never adaptive success", () => {
  const unavailable: RuntimeMemoryTelemetry = {
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
  const result = deriveRuntimeHeavyCapacity(input(unavailable));

  assert.equal(result.memorySafeHeadroom, 1);
  assert.equal(result.telemetryAvailability, "unavailable");
  assert.equal(result.reason, "telemetry_unavailable");
  assert.equal(result.limitingBudget, null);
  assert.deepEqual(result.consideredBudgets, []);
});
