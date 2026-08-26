import { performance } from "node:perf_hooks";
import v8 from "node:v8";

import { sampleRuntimeMemorySignals } from "../../../scripts/build/runtime-env.mjs";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** Conservative transient-memory reservation for one structurally-heavy request. */
export const DEFAULT_HEAVY_REQUEST_COST_BYTES = GiB;
export const MIN_HEAVY_REQUEST_COST_BYTES = 512 * MiB;
export const MAX_HEAVY_REQUEST_COST_BYTES = 8 * GiB;

/** Memory retained for the OS, application baseline, and unmodelled native work. */
export const DEFAULT_RESERVED_MEMORY_BYTES = 512 * MiB;
export const MIN_RESERVED_MEMORY_BYTES = 128 * MiB;
export const MAX_RESERVED_MEMORY_BYTES = 64 * GiB;

/** Capacity recovery must remain healthy for real elapsed time. */
export const DEFAULT_RECOVERY_STABLE_MS = 5_000;
export const MIN_RECOVERY_STABLE_MS = 1_000;
export const MAX_RECOVERY_STABLE_MS = 5 * 60_000;

/** Existing pressure threshold shared by the structural and adaptive gates. */
export const CHAT_ADMISSION_HEAP_SHED_RATIO = (() => {
  const parsed = Number(process.env.OMNIROUTE_CHAT_ADMISSION_HEAP_SHED_RATIO);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.75;
})();

export type RuntimeMemoryBudgetName =
  | "v8_heap"
  | "process_available"
  | "process_constrained"
  | "host_memory"
  | "cgroup_v1"
  | "cgroup_v2"
  | "cgroup_v2_high"
  | "eligible_supply";

export type RuntimeTelemetryAvailability =
  "available" | "partial" | "unavailable" | "invalid" | "override" | "configuration_invalid";

export type RuntimeHeavyHeadroomReason =
  | "environment_override"
  | "v8_heap_capacity"
  | "v8_heap_pressure"
  | "process_available_capacity"
  | "process_available_pressure"
  | "process_constrained_capacity"
  | "process_constrained_pressure"
  | "host_memory_capacity"
  | "host_memory_pressure"
  | "cgroup_v1_capacity"
  | "cgroup_v1_pressure"
  | "cgroup_v2_capacity"
  | "cgroup_v2_pressure"
  | "cgroup_v2_high_capacity"
  | "cgroup_v2_high_pressure"
  | "eligible_supply_capacity"
  | "telemetry_unavailable"
  | "telemetry_invalid"
  | "telemetry_contradictory"
  | "configuration_invalid"
  | "recovery_hysteresis";

export type RuntimeMemoryTelemetry = {
  heapLimitBytes: number | null;
  heapUsedBytes: number | null;
  /** Whole-process RSS, including native memory outside the V8 heap. */
  rssUsedBytes: number | null;
  /** Node external allocations; ArrayBuffers are normally a subset. */
  externalBytes: number | null;
  arrayBuffersBytes: number | null;
  /** libuv/Node memory budgets, already aware of supported container limits. */
  processAvailableBytes: number | null;
  processConstrainedBytes: number | null;
  hostTotalBytes: number | null;
  hostFreeBytes: number | null;
  cgroupVersion: "v1" | "v2" | null;
  cgroupLimitBytes: number | null;
  cgroupUsedBytes: number | null;
  /** cgroup v2 soft throttle ceiling when finite. */
  cgroupHighBytes?: number | null;
};

export type RuntimeMemoryTelemetryDeps = {
  readText?: (filePath: string) => string | null;
  memoryUsage?: () => NodeJS.MemoryUsage;
  heapStatistics?: () => { heap_size_limit: number; used_heap_size?: number };
  availableMemory?: () => number | undefined;
  constrainedMemory?: () => number | undefined;
  hostTotalMemory?: () => number;
  hostFreeMemory?: () => number;
};

export type RuntimeHeavyCapacityInput = RuntimeMemoryTelemetry & {
  /** Primary process-global heavyweight slots already available. */
  baseCapacity: number;
  /** Conservative extra slots used only when critical telemetry is unavailable. */
  legacyHeadroom: number;
  shedRatio: number;
  perRequestCostBytes?: number;
  reservedMemoryBytes?: number;
  /** Optional eligible-provider supply ceiling; never a source of memory capacity. */
  eligibleSupplyCapacity?: number | null;
};

/** Backward-compatible public name retained for the existing PR callers. */
export type RuntimeHeavyHeadroomInput = RuntimeHeavyCapacityInput;

export type RuntimeMemoryBudget = {
  name: RuntimeMemoryBudgetName;
  limitBytes: number;
  usedBytes: number;
  reserveBytes: number;
  availableBytes: number;
  capacity: number;
};

export type RuntimeHeavyHeadroomDerivation = {
  totalCapacity: number;
  memorySafeHeadroom: number;
  reason: RuntimeHeavyHeadroomReason;
  limitingBudget: RuntimeMemoryBudgetName | null;
  consideredBudgets: RuntimeMemoryBudget[];
  telemetryAvailability: RuntimeTelemetryAvailability;
  eligibleSupplyCapacity: number | null;
};

export type RuntimeHeavyHeadroomSnapshot = RuntimeHeavyHeadroomDerivation & {
  configuredHeadroom: number | null;
  effectiveHeadroom: number;
  calculatedTotalCapacity: number;
  memorySafeTotalCapacity: number;
};

export type RuntimeHeavyHeadroomPolicy = {
  getEffectiveHeadroom(): number;
  snapshot(): RuntimeHeavyHeadroomSnapshot;
};

export type RuntimeHeavyHeadroomPolicyOptions = {
  explicitHeadroom: number | null;
  baseCapacity: number;
  legacyHeadroom: number;
  shedRatio: number;
  sample?: () => RuntimeMemoryTelemetry;
  now?: () => number;
  recoveryStableMs?: number;
  perRequestCostBytes?: number;
  reservedMemoryBytes?: number;
  eligibleSupplyCapacity?: number | null;
  configurationValid?: boolean;
};

export type RuntimeHeavyHeadroomConfiguration = {
  perRequestCostBytes: number;
  reservedMemoryBytes: number;
  recoveryStableMs: number;
  valid: boolean;
};

export type RuntimeHeavyHeadroomConfigurationInput = {
  heavyRequestCostBytes?: string;
  reservedMemoryBytes?: string;
  recoveryStableMs?: string;
};

export type ConfiguredRuntimeHeavyHeadroom = {
  healthyHeadroom: number;
  policy: RuntimeHeavyHeadroomPolicy;
};

type ByteState = "valid" | "unavailable" | "invalid";

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): { value: number; valid: boolean } {
  if (value === undefined) return { value: fallback, valid: true };
  if (!/^(0|[1-9]\d*)$/.test(value)) return { value: fallback, valid: false };
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? { value: parsed, valid: true }
    : { value: fallback, valid: false };
}

function parseOptionalNonNegativeInteger(value: string | undefined): {
  value: number | null;
  valid: boolean;
} {
  if (value === undefined) return { value: null, valid: true };
  if (!/^(0|[1-9]\d*)$/.test(value)) return { value: null, valid: false };
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? { value: parsed, valid: true }
    : { value: null, valid: false };
}

/** Parse bounded adaptive settings without accepting partial numeric strings. */
export function resolveRuntimeHeavyHeadroomConfiguration(
  input: RuntimeHeavyHeadroomConfigurationInput
): RuntimeHeavyHeadroomConfiguration {
  const cost = parseBoundedInteger(
    input.heavyRequestCostBytes,
    DEFAULT_HEAVY_REQUEST_COST_BYTES,
    MIN_HEAVY_REQUEST_COST_BYTES,
    MAX_HEAVY_REQUEST_COST_BYTES
  );
  const reserved = parseBoundedInteger(
    input.reservedMemoryBytes,
    DEFAULT_RESERVED_MEMORY_BYTES,
    MIN_RESERVED_MEMORY_BYTES,
    MAX_RESERVED_MEMORY_BYTES
  );
  const recovery = parseBoundedInteger(
    input.recoveryStableMs,
    DEFAULT_RECOVERY_STABLE_MS,
    MIN_RECOVERY_STABLE_MS,
    MAX_RECOVERY_STABLE_MS
  );
  return {
    perRequestCostBytes: cost.value,
    reservedMemoryBytes: reserved.value,
    recoveryStableMs: recovery.value,
    valid: cost.valid && reserved.valid && recovery.valid,
  };
}

/** Build the process policy while preserving a valid exact fixed override. */
export function createConfiguredRuntimeHeavyHeadroom(
  baseCapacity: number
): ConfiguredRuntimeHeavyHeadroom {
  const explicit = parseOptionalNonNegativeInteger(
    process.env.OMNIROUTE_CHAT_ADMISSION_HEALTHY_HEADROOM
  );
  const adaptive = resolveRuntimeHeavyHeadroomConfiguration({
    heavyRequestCostBytes: process.env.OMNIROUTE_CHAT_ADMISSION_HEAVY_REQUEST_COST_BYTES,
    reservedMemoryBytes: process.env.OMNIROUTE_CHAT_ADMISSION_RESERVED_MEMORY_BYTES,
    recoveryStableMs: process.env.OMNIROUTE_CHAT_ADMISSION_RECOVERY_STABLE_MS,
  });
  return {
    healthyHeadroom: explicit.value ?? baseCapacity,
    policy: createRuntimeHeavyHeadroomPolicy({
      explicitHeadroom: explicit.value,
      baseCapacity,
      legacyHeadroom: baseCapacity,
      shedRatio: CHAT_ADMISSION_HEAP_SHED_RATIO,
      perRequestCostBytes: adaptive.perRequestCostBytes,
      reservedMemoryBytes: adaptive.reservedMemoryBytes,
      recoveryStableMs: adaptive.recoveryStableMs,
      configurationValid: explicit.valid && adaptive.valid,
    }),
  };
}

/** Live V8 pressure probe, injectable at the admission call site for tests. */
export function defaultHeapPressureCheck(): boolean {
  try {
    const heapUsed = process.memoryUsage().heapUsed;
    const heapLimit = v8.getHeapStatistics().heap_size_limit;
    if (!Number.isFinite(heapLimit) || heapLimit <= 0) return false;
    return heapUsed / heapLimit >= CHAT_ADMISSION_HEAP_SHED_RATIO;
  } catch {
    return false;
  }
}

function validateCoreInput(input: RuntimeHeavyCapacityInput): void {
  if (!isPositiveSafeInteger(input.baseCapacity)) {
    throw new RangeError("baseCapacity must be a positive safe integer");
  }
  if (!isNonNegativeSafeInteger(input.legacyHeadroom)) {
    throw new RangeError("legacyHeadroom must be a non-negative safe integer");
  }
  if (!Number.isFinite(input.shedRatio) || input.shedRatio <= 0 || input.shedRatio > 1) {
    throw new RangeError("shedRatio must be finite and in (0, 1]");
  }
  if (!isPositiveSafeInteger(input.perRequestCostBytes ?? DEFAULT_HEAVY_REQUEST_COST_BYTES)) {
    throw new RangeError("perRequestCostBytes must be a positive safe integer");
  }
  if (!isNonNegativeSafeInteger(input.reservedMemoryBytes ?? DEFAULT_RESERVED_MEMORY_BYTES)) {
    throw new RangeError("reservedMemoryBytes must be a non-negative safe integer");
  }
  if (
    input.eligibleSupplyCapacity !== undefined &&
    input.eligibleSupplyCapacity !== null &&
    !isNonNegativeSafeInteger(input.eligibleSupplyCapacity)
  ) {
    throw new RangeError("eligibleSupplyCapacity must be a non-negative safe integer or null");
  }
}

function classifyByteTelemetry(value: number | null | undefined, allowZero: boolean): ByteState {
  if (value === null || value === undefined) return "unavailable";
  if (
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= Number.MAX_SAFE_INTEGER
  ) {
    return "invalid";
  }
  if (!allowZero && value === 0) return "invalid";
  return "valid";
}

function fallbackDerivation(
  input: RuntimeHeavyCapacityInput,
  reason: Extract<
    RuntimeHeavyHeadroomReason,
    "telemetry_unavailable" | "telemetry_invalid" | "telemetry_contradictory"
  >,
  availability: Extract<RuntimeTelemetryAvailability, "unavailable" | "invalid">
): RuntimeHeavyHeadroomDerivation {
  return {
    totalCapacity: input.baseCapacity + input.legacyHeadroom,
    memorySafeHeadroom: input.legacyHeadroom,
    reason,
    limitingBudget: null,
    consideredBudgets: [],
    telemetryAvailability: availability,
    eligibleSupplyCapacity: input.eligibleSupplyCapacity ?? null,
  };
}

function capacityReason(
  name: Exclude<RuntimeMemoryBudgetName, "eligible_supply">,
  pressured: boolean
): RuntimeHeavyHeadroomReason {
  return `${name}_${pressured ? "pressure" : "capacity"}` as RuntimeHeavyHeadroomReason;
}

/**
 * Derive process-global heavy capacity from the tightest coherent memory budget.
 * Invalid optional signals are ignored and make availability `partial`; critical
 * V8/process-footprint telemetry fails to the explicit conservative fallback.
 */
export function deriveRuntimeHeavyCapacity(
  input: RuntimeHeavyCapacityInput
): RuntimeHeavyHeadroomDerivation {
  validateCoreInput(input);

  const critical = [
    classifyByteTelemetry(input.heapLimitBytes, false),
    classifyByteTelemetry(input.heapUsedBytes, true),
    classifyByteTelemetry(input.rssUsedBytes, true),
    classifyByteTelemetry(input.externalBytes, true),
    classifyByteTelemetry(input.arrayBuffersBytes, true),
  ];
  if (critical.includes("invalid")) {
    return fallbackDerivation(input, "telemetry_invalid", "invalid");
  }
  if (critical.includes("unavailable")) {
    return fallbackDerivation(input, "telemetry_unavailable", "unavailable");
  }

  const heapLimit = input.heapLimitBytes as number;
  const heapUsed = input.heapUsedBytes as number;
  if (heapUsed > heapLimit) {
    return fallbackDerivation(input, "telemetry_contradictory", "invalid");
  }

  const perRequestCost = input.perRequestCostBytes ?? DEFAULT_HEAVY_REQUEST_COST_BYTES;
  const reserve = input.reservedMemoryBytes ?? DEFAULT_RESERVED_MEMORY_BYTES;
  const rss = input.rssUsedBytes as number;
  const nativeExternal = Math.max(input.externalBytes as number, input.arrayBuffersBytes as number);
  const processFootprint = Math.max(rss, heapUsed + nativeExternal);
  const budgets: RuntimeMemoryBudget[] = [];
  let optionalInvalid = false;

  const addBudget = (
    name: Exclude<RuntimeMemoryBudgetName, "eligible_supply">,
    limitBytes: number,
    usedBytes: number,
    rawAvailableBytes: number,
    budgetOptions: { allowZeroLimit?: boolean; allowUsageAboveLimit?: boolean } = {}
  ): void => {
    const validLimit = budgetOptions.allowZeroLimit
      ? isNonNegativeSafeInteger(limitBytes)
      : isPositiveSafeInteger(limitBytes);
    if (
      !validLimit ||
      !isNonNegativeSafeInteger(usedBytes) ||
      (!budgetOptions.allowUsageAboveLimit && usedBytes > limitBytes) ||
      !Number.isFinite(rawAvailableBytes)
    ) {
      optionalInvalid = true;
      return;
    }
    const availableBytes = Math.max(0, Math.floor(rawAvailableBytes));
    budgets.push({
      name,
      limitBytes,
      usedBytes,
      reserveBytes: reserve,
      availableBytes,
      capacity: Math.max(0, Math.floor(availableBytes / perRequestCost)),
    });
  };

  addBudget(
    "v8_heap",
    heapLimit,
    heapUsed,
    Math.floor(heapLimit * input.shedRatio) - heapUsed - reserve
  );

  const processAvailableState = classifyByteTelemetry(input.processAvailableBytes, true);
  if (processAvailableState === "valid") {
    const available = input.processAvailableBytes as number;
    addBudget("process_available", available, 0, Math.floor(available * input.shedRatio) - reserve);
  } else if (processAvailableState === "invalid") {
    optionalInvalid = true;
  }

  const constrainedState = classifyByteTelemetry(input.processConstrainedBytes, false);
  if (constrainedState === "valid") {
    const constrained = input.processConstrainedBytes as number;
    const inferredUsed =
      processAvailableState === "valid" && (input.processAvailableBytes as number) <= constrained
        ? constrained - (input.processAvailableBytes as number)
        : processFootprint;
    addBudget(
      "process_constrained",
      constrained,
      Math.max(inferredUsed, processFootprint),
      Math.floor(constrained * input.shedRatio) - Math.max(inferredUsed, processFootprint) - reserve
    );
  } else if (constrainedState === "invalid") {
    optionalInvalid = true;
  }

  const hostTotalState = classifyByteTelemetry(input.hostTotalBytes, false);
  const hostFreeState = classifyByteTelemetry(input.hostFreeBytes, true);
  if (hostTotalState === "valid" && hostFreeState === "valid") {
    const total = input.hostTotalBytes as number;
    const free = input.hostFreeBytes as number;
    if (free <= total) {
      const used = Math.max(total - free, processFootprint);
      addBudget("host_memory", total, used, Math.floor(total * input.shedRatio) - used - reserve);
    } else {
      optionalInvalid = true;
    }
  } else if (hostTotalState === "invalid" || hostFreeState === "invalid") {
    optionalInvalid = true;
  } else if (hostTotalState !== hostFreeState) {
    optionalInvalid = true;
  }

  const cgroupLimitState = classifyByteTelemetry(input.cgroupLimitBytes, false);
  const cgroupUsedState = classifyByteTelemetry(input.cgroupUsedBytes, true);
  if (input.cgroupVersion !== null && cgroupLimitState === "valid" && cgroupUsedState === "valid") {
    const limit = input.cgroupLimitBytes as number;
    const used = Math.max(input.cgroupUsedBytes as number, processFootprint);
    addBudget(
      input.cgroupVersion === "v2" ? "cgroup_v2" : "cgroup_v1",
      limit,
      used,
      Math.floor(limit * input.shedRatio) - used - reserve
    );

    const highState = classifyByteTelemetry(input.cgroupHighBytes, true);
    if (input.cgroupVersion === "v2" && highState === "valid") {
      const high = input.cgroupHighBytes as number;
      if (high <= limit) {
        addBudget(
          "cgroup_v2_high",
          high,
          used,
          Math.floor(high * input.shedRatio) - used - reserve,
          { allowZeroLimit: true, allowUsageAboveLimit: true }
        );
      } else {
        optionalInvalid = true;
      }
    } else if (highState === "invalid") {
      optionalInvalid = true;
    }
  } else if (
    input.cgroupVersion !== null ||
    cgroupLimitState !== "unavailable" ||
    cgroupUsedState !== "unavailable"
  ) {
    optionalInvalid = true;
  }

  if (budgets.length === 0) {
    return fallbackDerivation(input, "telemetry_unavailable", "unavailable");
  }

  let limiting = budgets[0];
  for (const budget of budgets.slice(1)) {
    if (budget.availableBytes < limiting.availableBytes) limiting = budget;
  }
  let totalCapacity = Math.max(input.baseCapacity, limiting.capacity);
  let limitingBudget: RuntimeMemoryBudgetName = limiting.name;
  let reason = capacityReason(limiting.name, limiting.availableBytes <= 0);
  const eligibleSupplyCapacity = input.eligibleSupplyCapacity ?? null;
  if (
    eligibleSupplyCapacity !== null &&
    eligibleSupplyCapacity >= input.baseCapacity &&
    eligibleSupplyCapacity < totalCapacity
  ) {
    totalCapacity = eligibleSupplyCapacity;
    limitingBudget = "eligible_supply";
    reason = "eligible_supply_capacity";
  }

  return {
    totalCapacity,
    memorySafeHeadroom: Math.max(0, totalCapacity - input.baseCapacity),
    reason,
    limitingBudget,
    consideredBudgets: budgets,
    telemetryAvailability: optionalInvalid ? "partial" : "available",
    eligibleSupplyCapacity,
  };
}

/** Existing export retained for callers/tests while returning detailed capacity. */
export function deriveRuntimeHeavyHeadroom(
  input: RuntimeHeavyHeadroomInput
): RuntimeHeavyHeadroomDerivation {
  return deriveRuntimeHeavyCapacity(input);
}

/** Read the shared startup/runtime provider synchronously before first admission. */
export function sampleRuntimeMemoryTelemetry(
  deps: RuntimeMemoryTelemetryDeps = {}
): RuntimeMemoryTelemetry {
  const sample = sampleRuntimeMemorySignals(deps);
  return {
    heapLimitBytes: sample.heapLimitBytes,
    heapUsedBytes: sample.heapUsedBytes,
    rssUsedBytes: sample.rssUsedBytes,
    externalBytes: sample.externalBytes,
    arrayBuffersBytes: sample.arrayBuffersBytes,
    processAvailableBytes: sample.processAvailableBytes,
    processConstrainedBytes: sample.processConstrainedBytes,
    hostTotalBytes: sample.hostTotalBytes,
    hostFreeBytes: sample.hostFreeBytes,
    cgroupVersion: sample.cgroupVersion,
    cgroupLimitBytes: sample.cgroupLimitBytes,
    cgroupUsedBytes: sample.cgroupUsedBytes,
    cgroupHighBytes: sample.cgroupHighBytes,
  };
}

function staticSnapshot(
  options: RuntimeHeavyHeadroomPolicyOptions,
  headroom: number,
  reason: "environment_override" | "configuration_invalid",
  availability: "override" | "configuration_invalid"
): RuntimeHeavyHeadroomSnapshot {
  const total = options.baseCapacity + headroom;
  return {
    configuredHeadroom: reason === "environment_override" ? headroom : null,
    effectiveHeadroom: headroom,
    calculatedTotalCapacity: total,
    memorySafeTotalCapacity: total,
    totalCapacity: total,
    memorySafeHeadroom: headroom,
    reason,
    limitingBudget: null,
    consideredBudgets: [],
    telemetryAvailability: availability,
    eligibleSupplyCapacity: options.eligibleSupplyCapacity ?? null,
  };
}

/**
 * Stateful policy: initialize eagerly, contract on the first lower sample, and
 * recover only after a candidate remains healthy for a real elapsed interval.
 */
export function createRuntimeHeavyHeadroomPolicy(
  options: RuntimeHeavyHeadroomPolicyOptions
): RuntimeHeavyHeadroomPolicy {
  if (!isPositiveSafeInteger(options.baseCapacity)) {
    throw new RangeError("baseCapacity must be a positive safe integer");
  }
  if (!isNonNegativeSafeInteger(options.legacyHeadroom)) {
    throw new RangeError("legacyHeadroom must be a non-negative safe integer");
  }
  if (options.explicitHeadroom !== null && !isNonNegativeSafeInteger(options.explicitHeadroom)) {
    throw new RangeError("explicitHeadroom must be a non-negative safe integer or null");
  }
  const recoveryStableMs = options.recoveryStableMs ?? DEFAULT_RECOVERY_STABLE_MS;
  if (!isPositiveSafeInteger(recoveryStableMs)) {
    throw new RangeError("recoveryStableMs must be a positive safe integer");
  }

  if (options.explicitHeadroom !== null) {
    const snapshot = staticSnapshot(
      options,
      options.explicitHeadroom,
      "environment_override",
      "override"
    );
    return {
      getEffectiveHeadroom: () => snapshot.effectiveHeadroom,
      snapshot: () => ({ ...snapshot, consideredBudgets: [] }),
    };
  }

  if (options.configurationValid === false) {
    const snapshot = staticSnapshot(
      options,
      options.legacyHeadroom,
      "configuration_invalid",
      "configuration_invalid"
    );
    return {
      getEffectiveHeadroom: () => snapshot.effectiveHeadroom,
      snapshot: () => ({ ...snapshot, consideredBudgets: [] }),
    };
  }

  const sample = options.sample ?? sampleRuntimeMemoryTelemetry;
  const now = options.now ?? (() => performance.now());
  let initialized = false;
  let effectiveHeadroom = options.legacyHeadroom;
  let latest = fallbackDerivation(
    {
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
      baseCapacity: options.baseCapacity,
      legacyHeadroom: options.legacyHeadroom,
      shedRatio: options.shedRatio,
    },
    "telemetry_unavailable",
    "unavailable"
  );
  let reason: RuntimeHeavyHeadroomReason = latest.reason;
  let pendingGrowth: number | null = null;
  let pendingGrowthSince: number | null = null;

  const derive = (): RuntimeHeavyHeadroomDerivation => {
    let current: RuntimeMemoryTelemetry;
    try {
      current = sample();
    } catch {
      current = {
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
    }
    return deriveRuntimeHeavyCapacity({
      ...current,
      baseCapacity: options.baseCapacity,
      legacyHeadroom: options.legacyHeadroom,
      shedRatio: options.shedRatio,
      perRequestCostBytes: options.perRequestCostBytes,
      reservedMemoryBytes: options.reservedMemoryBytes,
      eligibleSupplyCapacity: options.eligibleSupplyCapacity,
    });
  };

  const readNow = (): number | null => {
    try {
      const value = now();
      return Number.isFinite(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  };

  const refresh = (): number => {
    latest = derive();
    const memorySafeHeadroom = latest.memorySafeHeadroom;

    if (!initialized) {
      initialized = true;
      effectiveHeadroom = memorySafeHeadroom;
      reason = latest.reason;
      return effectiveHeadroom;
    }

    if (memorySafeHeadroom <= effectiveHeadroom) {
      effectiveHeadroom = memorySafeHeadroom;
      pendingGrowth = null;
      pendingGrowthSince = null;
      reason = latest.reason;
      return effectiveHeadroom;
    }

    const currentTime = readNow();
    if (currentTime === null) {
      pendingGrowth = null;
      pendingGrowthSince = null;
      reason = "recovery_hysteresis";
      return effectiveHeadroom;
    }
    if (
      pendingGrowth !== memorySafeHeadroom ||
      pendingGrowthSince === null ||
      currentTime < pendingGrowthSince
    ) {
      pendingGrowth = memorySafeHeadroom;
      pendingGrowthSince = currentTime;
      reason = "recovery_hysteresis";
      return effectiveHeadroom;
    }
    if (currentTime - pendingGrowthSince < recoveryStableMs) {
      reason = "recovery_hysteresis";
      return effectiveHeadroom;
    }

    effectiveHeadroom = memorySafeHeadroom;
    pendingGrowth = null;
    pendingGrowthSince = null;
    reason = latest.reason;
    return effectiveHeadroom;
  };

  // The production provider is initialized during controller construction, so
  // healthy startup never reports telemetry_unavailable merely because no chat
  // request has reached the gate yet.
  refresh();

  return {
    getEffectiveHeadroom: refresh,
    snapshot: () => {
      refresh();
      return {
        ...latest,
        configuredHeadroom: null,
        effectiveHeadroom,
        calculatedTotalCapacity: options.baseCapacity + effectiveHeadroom,
        memorySafeTotalCapacity: latest.totalCapacity,
        reason,
        consideredBudgets: latest.consideredBudgets.map((budget) => ({ ...budget })),
      };
    },
  };
}
