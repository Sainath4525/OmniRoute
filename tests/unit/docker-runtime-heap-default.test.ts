import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveStandaloneHeapConfiguration } from "../../scripts/build/runtime-env.mjs";

const MiB = 1024 * 1024;

const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
const launcher = readFileSync(
  new URL("../../scripts/dev/run-standalone.mjs", import.meta.url),
  "utf8"
);
const runtimeEnv = readFileSync(
  new URL("../../scripts/build/runtime-env.mjs", import.meta.url),
  "utf8"
);

function stage(name: string): string {
  const match = dockerfile.match(
    new RegExp(`FROM\\s+\\S+\\s+AS\\s+${name}\\b([\\s\\S]*?)(?=\\nFROM\\s|$)`, "i")
  );
  assert.ok(match, `Dockerfile must contain ${name}`);
  return match[1];
}

test("official Docker runtime no longer pins the former 1024 MiB heap", () => {
  const runner = stage("runner-base");

  assert.doesNotMatch(runner, /^ENV OMNIROUTE_MEMORY_MB=/m);
  assert.doesNotMatch(runner, /^ENV NODE_OPTIONS=.*max-old-space-size/m);
  assert.doesNotMatch(compose, /^\s*- NODE_OPTIONS=.*max-old-space-size/m);
});

test("official Docker starts the server through the runtime heap calibrator", () => {
  assert.match(launcher, /resolveStandaloneHeapConfiguration/);
  assert.match(runtimeEnv, /calibrateHeapFallbackMb/);
  assert.match(runtimeEnv, /process\.constrainedMemory/);
  assert.match(runtimeEnv, /process\.availableMemory/);
  assert.match(runtimeEnv, /process\.memoryUsage/);
  assert.match(runtimeEnv, /sampleRuntimeCgroupMemory/);
  assert.match(launcher, /spawnWithForwardedSignals\("node"/);
});

function spawnedHeapLimitMiB(nodeOptions: string): number {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import v8 from "node:v8"; console.log(Math.floor(v8.getHeapStatistics().heap_size_limit / 1048576));',
    ],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", NODE_OPTIONS: nodeOptions },
    }
  );
  return Number(output.trim());
}

test("large-host automatic mode changes the actual standalone child V8 heap", () => {
  const resolved = resolveStandaloneHeapConfiguration(
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
  const actualHeapMiB = spawnedHeapLimitMiB(resolved.nodeOptions);

  assert.equal(resolved.source, "automatic");
  assert.ok(resolved.maxOldSpaceMb > 1024);
  assert.ok(actualHeapMiB > 1024, `actual child heap remained ${actualHeapMiB} MiB`);
});

test("the former official 1024 MiB contract reproduces the small actual child heap", () => {
  const former = resolveStandaloneHeapConfiguration(
    { OMNIROUTE_MEMORY_MB: "1024" },
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
  const actualHeapMiB = spawnedHeapLimitMiB(former.nodeOptions);

  assert.equal(former.maxOldSpaceMb, 1024);
  assert.ok(actualHeapMiB >= 1024 && actualHeapMiB < 1300, String(actualHeapMiB));
});

test("explicit OMNIROUTE_MEMORY_MB remains the actual standalone child heap authority", () => {
  const resolved = resolveStandaloneHeapConfiguration(
    { OMNIROUTE_MEMORY_MB: "1536" },
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
  const actualHeapMiB = spawnedHeapLimitMiB(resolved.nodeOptions);

  assert.equal(resolved.source, "omniroute_memory_mb");
  assert.equal(resolved.maxOldSpaceMb, 1536);
  assert.ok(actualHeapMiB >= 1536 && actualHeapMiB < 1800, String(actualHeapMiB));
});

test("startup resolves the child heap before spawning the server process", () => {
  const resolution = launcher.indexOf("resolveStandaloneHeapConfiguration");
  const spawn = launcher.indexOf('spawnWithForwardedSignals("node"');

  assert.ok(resolution >= 0, "launcher must resolve the heap configuration");
  assert.ok(spawn > resolution, "heap configuration must precede the real child spawn");
});
