#!/usr/bin/env node

import { existsSync } from "node:fs";
import {
  resolveRuntimePorts,
  withRuntimePortEnv,
  warnConflictingHeapLimits,
  resolveStandaloneHeapConfiguration,
  spawnWithForwardedSignals,
} from "../build/runtime-env.mjs";
import { bootstrapEnv } from "../build/bootstrap-env.mjs";

const env = bootstrapEnv();
const runtimePorts = resolveRuntimePorts(env);
const childEnv = withRuntimePortEnv(env, runtimePorts);

// #2939 / #10353: OMNIROUTE_MEMORY_MB is the Docker/standalone heap knob.
// When it is set, we append --max-old-space-size last (V8 last-flag wins).
// When it is unset and NODE_OPTIONS already pins the heap, keep NODE_OPTIONS
// (#5238). Otherwise derive a cgroup/process-aware fallback before the actual
// server Node process starts. Warn when both explicit knobs disagree.
const heapConfiguration = resolveStandaloneHeapConfiguration(childEnv);
warnConflictingHeapLimits(childEnv, heapConfiguration.maxOldSpaceMb);
childEnv.NODE_OPTIONS = heapConfiguration.nodeOptions;

// Prefer the WS-aware wrapper (server-ws.mjs) over the bare Next standalone
// server.js: it installs the trusted peer-IP stamp (scripts/dev/peer-stamp.mjs)
// that the authz middleware needs to allow loopback/LAN access to LOCAL_ONLY
// routes. Falling back to server.js fails CLOSED (every LOCAL_ONLY request 403s)
// rather than trusting the spoofable Host header.
const entry = existsSync("server-ws.mjs") ? "server-ws.mjs" : "server.js";

spawnWithForwardedSignals("node", [entry], {
  stdio: "inherit",
  env: childEnv,
});
