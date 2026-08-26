import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import path from "node:path";
import v8 from "node:v8";

const DEFAULT_CGROUP_ROOT = "/sys/fs/cgroup";

function defaultReadText(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/** Normalize a byte counter without accepting cgroup unlimited sentinels. */
export function sanitizeRuntimeMemoryBytes(value, { allowZero = false } = {}) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "max" || !/^\d+$/.test(trimmed)) return null;
    try {
      const parsed = BigInt(trimmed);
      if (parsed >= BigInt(Number.MAX_SAFE_INTEGER)) return null;
      value = Number(parsed);
    } catch {
      return null;
    }
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= Number.MAX_SAFE_INTEGER
  ) {
    return null;
  }
  if (!allowZero && value === 0) return null;
  return value;
}

function decodeMountPath(value) {
  if (typeof value !== "string" || value.includes("\0")) return null;
  return value.replace(/\\([0-7]{3})/g, (_match, octal) =>
    String.fromCharCode(Number.parseInt(octal, 8))
  );
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveMountedCgroupPath(cgroupPath, mountRoot, mountPoint) {
  const decodedRoot = decodeMountPath(mountRoot);
  const decodedMount = decodeMountPath(mountPoint);
  if (!decodedRoot?.startsWith("/") || !decodedMount?.startsWith("/")) return null;
  if (!cgroupPath.startsWith("/") || cgroupPath.includes("\0")) return null;
  if (cgroupPath.split("/").some((segment) => segment === "." || segment === "..")) return null;
  const root = path.resolve(decodedRoot);
  const group = path.resolve(cgroupPath);
  if (!isContained(root, group)) return null;
  const mount = path.resolve(decodedMount);
  const candidate = path.resolve(mount, path.relative(root, group));
  return isContained(mount, candidate) ? candidate : null;
}

function parseCgroupMembership(contents) {
  const membership = { v2Path: null, v1MemoryPath: null };
  if (!contents) return membership;
  for (const rawLine of contents.split("\n")) {
    const fields = rawLine.trim().split(":", 3);
    if (fields.length !== 3 || !fields[2].startsWith("/")) continue;
    if (fields[0] === "0" && fields[1] === "") membership.v2Path = fields[2];
    if (fields[1].split(",").includes("memory")) membership.v1MemoryPath = fields[2];
  }
  return membership;
}

function parseCgroupMounts(contents) {
  const mounts = { v2: null, v1Memory: null };
  if (!contents) return mounts;
  for (const rawLine of contents.split("\n")) {
    const separator = rawLine.indexOf(" - ");
    if (separator < 0) continue;
    const left = rawLine.slice(0, separator).trim().split(/\s+/);
    const right = rawLine
      .slice(separator + 3)
      .trim()
      .split(/\s+/);
    if (left.length < 5 || right.length < 3) continue;
    const mount = { root: left[3], mountPoint: left[4] };
    if (right[0] === "cgroup2") mounts.v2 = mount;
    if (right[0] === "cgroup" && right.slice(1).join(",").split(",").includes("memory")) {
      mounts.v1Memory = mount;
    }
  }
  return mounts;
}

function readCgroupPair(readText, directory, limitName, usageName, highName = null) {
  if (!directory) return null;
  const limit = sanitizeRuntimeMemoryBytes(readText(path.join(directory, limitName)));
  const usage = sanitizeRuntimeMemoryBytes(readText(path.join(directory, usageName)), {
    allowZero: true,
  });
  if (limit === null || usage === null || usage > limit) return null;
  const high = highName
    ? sanitizeRuntimeMemoryBytes(readText(path.join(directory, highName)), { allowZero: true })
    : null;
  return { limitBytes: limit, usedBytes: usage, highBytes: high };
}

/**
 * Resolve the current process's finite cgroup memory budget. Both cgroup v2 and
 * the legacy v1 memory controller are supported; unlimited and contradictory
 * pairs are deliberately absent rather than converted into fake capacity.
 */
export function sampleRuntimeCgroupMemory(readText = defaultReadText) {
  const membership = parseCgroupMembership(readText("/proc/self/cgroup"));
  const mounts = parseCgroupMounts(readText("/proc/self/mountinfo"));

  if (membership.v2Path) {
    const mounted = mounts.v2
      ? resolveMountedCgroupPath(membership.v2Path, mounts.v2.root, mounts.v2.mountPoint)
      : null;
    const pair =
      readCgroupPair(readText, mounted, "memory.max", "memory.current", "memory.high") ??
      readCgroupPair(readText, DEFAULT_CGROUP_ROOT, "memory.max", "memory.current", "memory.high");
    if (pair) return { version: "v2", ...pair };
  }

  if (membership.v1MemoryPath) {
    const mounted = mounts.v1Memory
      ? resolveMountedCgroupPath(
          membership.v1MemoryPath,
          mounts.v1Memory.root,
          mounts.v1Memory.mountPoint
        )
      : null;
    const fallback = path.join(
      DEFAULT_CGROUP_ROOT,
      "memory",
      membership.v1MemoryPath.replace(/^\/+/, "")
    );
    const pair =
      readCgroupPair(readText, mounted, "memory.limit_in_bytes", "memory.usage_in_bytes") ??
      readCgroupPair(readText, fallback, "memory.limit_in_bytes", "memory.usage_in_bytes");
    if (pair) return { version: "v1", ...pair };
  }

  return { version: null, limitBytes: null, usedBytes: null, highBytes: null };
}

function safeRuntimeCall(call, options) {
  try {
    return sanitizeRuntimeMemoryBytes(call?.(), options);
  } catch {
    return null;
  }
}

/**
 * One repository-wide synchronous memory sample used both before the server is
 * spawned and by structural admission after startup. Dependency injection keeps
 * cgroup layouts and invalid/sentinel values deterministic in unit tests.
 */
export function sampleRuntimeMemorySignals(deps = {}) {
  let memory = null;
  let heap = null;
  try {
    memory = (deps.memoryUsage ?? (() => process.memoryUsage()))();
  } catch {
    // Individual process fields remain unavailable.
  }
  try {
    heap = (deps.heapStatistics ?? (() => v8.getHeapStatistics()))();
  } catch {
    // Admission will identify unavailable critical V8 telemetry explicitly.
  }
  const cgroup = sampleRuntimeCgroupMemory(deps.readText ?? defaultReadText);

  return {
    heapLimitBytes: sanitizeRuntimeMemoryBytes(heap?.heap_size_limit),
    heapUsedBytes: sanitizeRuntimeMemoryBytes(heap?.used_heap_size ?? memory?.heapUsed, {
      allowZero: true,
    }),
    rssUsedBytes: sanitizeRuntimeMemoryBytes(memory?.rss, { allowZero: true }),
    externalBytes: sanitizeRuntimeMemoryBytes(memory?.external, { allowZero: true }),
    arrayBuffersBytes: sanitizeRuntimeMemoryBytes(memory?.arrayBuffers, { allowZero: true }),
    processAvailableBytes: safeRuntimeCall(
      deps.availableMemory ?? (() => process.availableMemory?.())
    ),
    processConstrainedBytes: safeRuntimeCall(
      deps.constrainedMemory ?? (() => process.constrainedMemory?.())
    ),
    hostTotalBytes: safeRuntimeCall(deps.hostTotalMemory ?? totalmem),
    hostFreeBytes: safeRuntimeCall(deps.hostFreeMemory ?? freemem, { allowZero: true }),
    cgroupVersion: cgroup.version,
    cgroupLimitBytes: cgroup.limitBytes,
    cgroupUsedBytes: cgroup.usedBytes,
    cgroupHighBytes: cgroup.highBytes,
  };
}

export function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

/**
 * Resolve the V8 heap ceiling (MB) for the server process from
 * `OMNIROUTE_MEMORY_MB`, mirroring `omniroute serve`. Clamped to [64, 16384];
 * invalid/unset → fallback (512). The standalone launcher uses this so
 * OMNIROUTE_MEMORY_MB can override the Docker image's NODE_OPTIONS fallback
 * without clobbering any other runtime flags (#2939).
 * @param {string | number | undefined | null} value
 * @param {number} [fallback]
 */
export function resolveMaxOldSpaceMb(value, fallback = 512) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 64 && parsed <= 16384 ? parsed : fallback;
}

/**
 * Derive the default V8 heap ceiling from the most restrictive trustworthy
 * startup budget: host total, cgroup/process constraint, and current
 * process-available memory plus the launcher's RSS. The latter keeps a busy
 * unconstrained host from sizing from installed RAM that is not actually free.
 *
 * The result retains the existing OMNIROUTE_MEMORY_MB contract ([64, 16384])
 * and targets 35% of the effective budget, leaving most memory for native
 * buffers, SQLite, sibling processes, and the OS. We intentionally keep using
 * the existing absolute `--max-old-space-size` launcher path rather than add
 * Node's percentage flag as a second memory-control system.
 *
 * @param {number | undefined | null} totalmemBytes — typically `os.totalmem()`
 * @param {{
 *   constrainedMemoryBytes?: number | undefined | null,
 *   availableMemoryBytes?: number | undefined | null,
 *   rssBytes?: number | undefined | null
 * }} [runtimeSignals]
 */
export function calibrateHeapFallbackMb(totalmemBytes, runtimeSignals = {}) {
  const budgets = [];
  const addBudget = (value) => {
    const numeric = sanitizeRuntimeMemoryBytes(value);
    if (numeric !== null) budgets.push(numeric);
  };

  addBudget(totalmemBytes);
  addBudget(runtimeSignals.constrainedMemoryBytes);
  addBudget(runtimeSignals.processConstrainedBytes);
  addBudget(runtimeSignals.cgroupLimitBytes);

  const available = sanitizeRuntimeMemoryBytes(
    runtimeSignals.availableMemoryBytes ?? runtimeSignals.processAvailableBytes,
    { allowZero: true }
  );
  const rss = sanitizeRuntimeMemoryBytes(runtimeSignals.rssBytes ?? runtimeSignals.rssUsedBytes, {
    allowZero: true,
  });
  if (available !== null) {
    const processBudget =
      rss !== null && available <= Number.MAX_SAFE_INTEGER - rss ? available + rss : available;
    addBudget(processBudget);
  }

  const hostFree = sanitizeRuntimeMemoryBytes(runtimeSignals.hostFreeBytes, { allowZero: true });
  if (hostFree !== null) {
    const hostAvailableBudget =
      rss !== null && hostFree <= Number.MAX_SAFE_INTEGER - rss ? hostFree + rss : hostFree;
    addBudget(hostAvailableBudget);
  }

  if (budgets.length === 0) return 512;
  const effectiveMb = Math.min(...budgets) / (1024 * 1024);
  const target = Math.floor(effectiveMb * 0.35);
  return Math.min(16384, Math.max(64, target));
}

/** Read Node's cgroup/process-aware startup signals without making them mandatory. */
export function sampleRuntimeHeapCalibrationSignals(runtimeProcess = process) {
  const sampled = sampleRuntimeMemorySignals({
    constrainedMemory: () => runtimeProcess.constrainedMemory?.(),
    availableMemory: () => runtimeProcess.availableMemory?.(),
    memoryUsage: () => runtimeProcess.memoryUsage(),
  });
  return {
    constrainedMemoryBytes: sampled.processConstrainedBytes,
    availableMemoryBytes: sampled.processAvailableBytes,
    rssBytes: sampled.rssUsedBytes,
    ...sampled,
  };
}

const MAX_OLD_SPACE_FLAG = "--max-old-space-size";

/**
 * True when the caller already pinned the V8 heap via NODE_OPTIONS
 * (`--max-old-space-size=…`). Used to decide whether `omniroute serve` may
 * append/inject the calibrated default — a user-set value must always win.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function envHasExplicitHeapFlag(env) {
  const sourceEnv = arguments.length === 0 ? process.env : env;
  return String(sourceEnv?.NODE_OPTIONS || "").includes(MAX_OLD_SPACE_FLAG);
}

/** Last `--max-old-space-size=` value in NODE_OPTIONS, or null if absent. */
export function parseNodeOptionsHeapMb(nodeOptions) {
  const matches = [...String(nodeOptions || "").matchAll(/--max-old-space-size=(\d+)/g)];
  if (matches.length === 0) return null;
  const parsed = Number.parseInt(matches[matches.length - 1][1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * True when OMNIROUTE_MEMORY_MB is an explicit in-range integer (not the
 * unset/invalid fallback). Docker images set this; Compose may also set
 * NODE_OPTIONS — #10353 needs to know both knobs were intentionally present.
 */
export function envHasExplicitOmnirouteMemoryMb(env) {
  const sourceEnv = arguments.length === 0 ? process.env : env;
  const parsed = Number.parseInt(String(sourceEnv?.OMNIROUTE_MEMORY_MB ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 64 && parsed <= 16384;
}

/**
 * Docker `run-standalone.mjs` appends `--max-old-space-size` from
 * OMNIROUTE_MEMORY_MB. V8 last-flag semantics mean that appended value wins
 * over an earlier NODE_OPTIONS heap. Warn once when both are set and disagree
 * so env dumps stop looking like NODE_OPTIONS is in effect (#10353).
 *
 * @returns {boolean} true when a warn was emitted
 */
export function warnConflictingHeapLimits(env, omnirouteMb, log = console.warn) {
  const nodeMb = parseNodeOptionsHeapMb(env?.NODE_OPTIONS);
  if (nodeMb == null || !envHasExplicitOmnirouteMemoryMb(env)) return false;
  if (nodeMb === omnirouteMb) return false;
  log(
    `[omniroute] heap limit conflict: OMNIROUTE_MEMORY_MB=${omnirouteMb} disagrees with NODE_OPTIONS --max-old-space-size=${nodeMb}. ` +
      `run-standalone.mjs / Docker appends OMNIROUTE_MEMORY_MB last, so the effective V8 heap is ${omnirouteMb} MB. ` +
      `Set only OMNIROUTE_MEMORY_MB (recommended) or make both values match.`
  );
  return true;
}

/**
 * NODE_OPTIONS string for Docker / run-standalone.mjs.
 * Explicit OMNIROUTE_MEMORY_MB always appends (wins). Otherwise keep an
 * existing NODE_OPTIONS heap flag (#5238). Otherwise append the fallback.
 */
export function buildStandaloneNodeOptions(env = process.env, omnirouteMb) {
  const existing = String(env?.NODE_OPTIONS || "").trim();
  if (envHasExplicitOmnirouteMemoryMb(env)) {
    return `${existing} ${MAX_OLD_SPACE_FLAG}=${omnirouteMb}`.trim();
  }
  if (existing.includes(MAX_OLD_SPACE_FLAG)) return existing;
  return `${existing} ${MAX_OLD_SPACE_FLAG}=${omnirouteMb}`.trim();
}

/**
 * Resolve the official standalone/Docker child heap before Node starts.
 * `OMNIROUTE_MEMORY_MB` retains the existing highest precedence in this
 * launcher; otherwise a documented NODE_OPTIONS heap is preserved; automatic
 * mode uses the validated host/process/cgroup sample.
 */
export function resolveStandaloneHeapConfiguration(env = process.env, runtimeSignals = null) {
  const signals = runtimeSignals ?? sampleRuntimeMemorySignals();
  const automaticMb = calibrateHeapFallbackMb(signals.hostTotalBytes, signals);
  const explicitOmniroute = envHasExplicitOmnirouteMemoryMb(env);
  const explicitNodeMb = parseNodeOptionsHeapMb(env?.NODE_OPTIONS);
  const maxOldSpaceMb = explicitOmniroute
    ? resolveMaxOldSpaceMb(env.OMNIROUTE_MEMORY_MB, automaticMb)
    : (explicitNodeMb ?? automaticMb);
  return {
    maxOldSpaceMb,
    nodeOptions: buildStandaloneNodeOptions(env, maxOldSpaceMb),
    source: explicitOmniroute
      ? "omniroute_memory_mb"
      : explicitNodeMb !== null
        ? "node_options"
        : "automatic",
    signals,
  };
}

/**
 * Assemble the NODE_OPTIONS string for the spawned server, preserving any flags
 * the user already exported. #5238: `omniroute serve` used to UNCONDITIONALLY
 * overwrite NODE_OPTIONS with the calibrated `--max-old-space-size`, silently
 * discarding a user-set `NODE_OPTIONS=--max-old-space-size=8192` (reporter set
 * 8192 and still OOM'd at ~505MB). Mirrors the Electron (electron/main.js) and
 * standalone (scripts/dev/run-standalone.mjs) launchers:
 *   - if NODE_OPTIONS already contains `--max-old-space-size`, keep it as-is
 *     (the user's value wins);
 *   - otherwise append the calibrated `--max-old-space-size=<memoryLimit>` to
 *     the existing NODE_OPTIONS, preserving unrelated flags (e.g.
 *     `--enable-source-maps`).
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @param {number} memoryLimit — calibrated V8 heap ceiling (MB)
 * @returns {string} the NODE_OPTIONS value to pass to the child process
 */
export function buildServerNodeOptions(env = process.env, memoryLimit) {
  const existing = String(env?.NODE_OPTIONS || "").trim();
  if (existing.includes(MAX_OLD_SPACE_FLAG)) return existing;
  return `${existing} ${MAX_OLD_SPACE_FLAG}=${memoryLimit}`.trim();
}

/**
 * Build the leading `node` CLI args that pin the V8 heap. When the user already
 * pinned the heap via NODE_OPTIONS, return `[]` so we do NOT inject a
 * conflicting/shadowing CLI `--max-old-space-size` (CLI args override
 * NODE_OPTIONS, which would re-introduce #5238). Otherwise return the calibrated
 * flag — NODE_OPTIONS already carries the same value, so this stays redundant
 * (identical value), never conflicting.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @param {number} memoryLimit — calibrated V8 heap ceiling (MB)
 * @returns {string[]}
 */
export function buildNodeHeapArgs(env = process.env, memoryLimit) {
  return envHasExplicitHeapFlag(env) ? [] : [`${MAX_OLD_SPACE_FLAG}=${memoryLimit}`];
}

/**
 * Build the complete argument list for spawning the Node.js server runtime.
 * Prefer IPv4 DNS results before starting the application so undici does not
 * stall on hosts whose IPv6 route silently drops outbound connections.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @param {number} memoryLimit — calibrated V8 heap ceiling (MB)
 * @param {string} serverPath — standalone server entrypoint
 * @returns {string[]}
 */
export function buildNodeRuntimeArgs(env = process.env, memoryLimit, serverPath) {
  return ["--dns-result-order=ipv4first", ...buildNodeHeapArgs(env, memoryLimit), serverPath];
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [fromEnv]
 *        Defaults to process.env. Pass bootstrap `merged` so project `.env` PORT applies before spawn.
 */
export function resolveRuntimePorts(fromEnv = process.env) {
  const basePort = parsePort(fromEnv.PORT || "20128", 20128);
  const apiPort = parsePort(fromEnv.API_PORT || String(basePort), basePort);
  const dashboardPort = parsePort(fromEnv.DASHBOARD_PORT || String(basePort), basePort);

  return { basePort, apiPort, dashboardPort };
}

export function withRuntimePortEnv(env, runtimePorts) {
  const { basePort, apiPort, dashboardPort } = runtimePorts;

  return {
    ...env,
    OMNIROUTE_PORT: String(basePort),
    PORT: String(dashboardPort),
    DASHBOARD_PORT: String(dashboardPort),
    API_PORT: String(apiPort),
    HOSTNAME: env.OMNIROUTE_HOSTNAME || "0.0.0.0",
  };
}

export function sanitizeColorEnv(env = {}) {
  const sanitized = { ...env };

  // Node warns when both FORCE_COLOR and NO_COLOR are set.
  // Prefer NO_COLOR in test tooling to avoid noisy process warnings.
  if (typeof sanitized.FORCE_COLOR !== "undefined" && typeof sanitized.NO_COLOR !== "undefined") {
    delete sanitized.FORCE_COLOR;
  }

  return sanitized;
}

export function spawnWithForwardedSignals(command, args, options = {}) {
  const child = spawn(command, args, options);

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));

  return child;
}
