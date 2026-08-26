/**
 * Issue #5172 / #5160 / #5152 — server OOM ("Ineffective mark-compacts near heap
 * limit ... ~500MB") on machines with plenty of RAM. Root cause: the server was
 * spawned with a FIXED 512MB heap default (`omniroute serve`) or with no
 * `--max-old-space-size` at all (Electron), so a 16GB box with 65 providers /
 * 2600 models still crashed at ~512MB.
 *
 * Fix: `calibrateHeapFallbackMb(totalmemBytes, runtimeSignals)` derives a sane
 * default heap from the most restrictive host/cgroup/process-available budget.
 * An explicit `OMNIROUTE_MEMORY_MB` still wins (resolveMaxOldSpaceMb), and the
 * existing #2939 contract is unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { calibrateHeapFallbackMb, resolveMaxOldSpaceMb } =
  await import("../../scripts/build/runtime-env.mjs");

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

test("#5172 calibrates the default heap to ~35% of physical RAM", () => {
  // 8GB → 8192 * 0.35 ≈ 2867
  assert.equal(calibrateHeapFallbackMb(8 * GB), 2867);
  // 4GB → floor(4096 * 0.35) = 1433
  assert.equal(calibrateHeapFallbackMb(4 * GB), 1433);
});

test("#5172 clamps the calibrated default to the supported [64, 16384] contract", () => {
  assert.equal(calibrateHeapFallbackMb(16 * GB), 5734);
  assert.equal(calibrateHeapFallbackMb(64 * GB), 16384);
  assert.equal(calibrateHeapFallbackMb(1 * GB), 358);
  assert.equal(calibrateHeapFallbackMb(64 * MB), 64);
});

test("#5172 falls back to 512 for missing/invalid totalmem", () => {
  assert.equal(calibrateHeapFallbackMb(0), 512);
  assert.equal(calibrateHeapFallbackMb(undefined), 512);
  assert.equal(calibrateHeapFallbackMb(null), 512);
  assert.equal(calibrateHeapFallbackMb(NaN), 512);
  assert.equal(calibrateHeapFallbackMb(-1), 512);
});

test("#5172 an explicit OMNIROUTE_MEMORY_MB still wins over the calibrated default", () => {
  const calibrated = calibrateHeapFallbackMb(64 * GB); // 16384
  // explicit override (in-range) is honored verbatim, not the calibrated default
  assert.equal(resolveMaxOldSpaceMb("1536", calibrated), 1536);
  // unset → the calibrated default is used (not the old fixed 512/1024)
  assert.equal(resolveMaxOldSpaceMb(undefined, calibrated), 16384);
});

test("large unconstrained Docker hosts derive from current process-available memory", () => {
  const measured = calibrateHeapFallbackMb(62115 * MB, {
    constrainedMemoryBytes: 18_446_744_073_709_552_000,
    availableMemoryBytes: 51200 * MB,
    rssBytes: 856 * MB,
  });

  assert.equal(measured, 16384);
  assert.ok(measured > 1024, "the former official Docker pin must not survive auto startup");
});

test("a small cgroup contracts automatic heap derivation below the host budget", () => {
  const constrained = calibrateHeapFallbackMb(62115 * MB, {
    constrainedMemoryBytes: 1024 * MB,
    availableMemoryBytes: 700 * MB,
    rssBytes: 64 * MB,
  });

  assert.equal(constrained, 267);
  assert.ok(constrained < 512, "small containers must retain native-memory headroom");
});
