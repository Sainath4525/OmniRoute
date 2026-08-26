import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_SPECS } from "../../src/shared/constants/modelSpecs.ts";
import { resolveModelAlias } from "../../open-sse/services/modelDeprecation.ts";
import { resolveLifecycle } from "../../open-sse/handlers/chatCore/modelLifecyclePolicy.ts";

/**
 * Bare `qwen3.8-max` was originally an unroutable id and therefore gained a global
 * compatibility alias to `qwen3.8-max-preview`. Some providers now advertise the GA
 * bare id while qoder and bailian-coding-plan still advertise the preview id.
 *
 * The unscoped compatibility alias remains useful, while provider-aware lifecycle
 * resolution preserves an id that the selected provider explicitly advertises. The
 * single preview MODEL_SPECS entry still supplies the shared 1M-token capability data
 * through its `qwen3.8-max` alias.
 */

const BARE = "qwen3.8-max";
const CANONICAL = "qwen3.8-max-preview";

test("bare qwen3.8-max resolves to the canonical -preview id", () => {
  assert.equal(resolveModelAlias(BARE), CANONICAL);
});

test("the canonical id is a no-op through the alias map (no double rewrite)", () => {
  assert.equal(resolveModelAlias(CANONICAL), CANONICAL);
});

test("the alias target carries the real 1M window, not the 128k fallback", () => {
  const spec = MODEL_SPECS[CANONICAL];
  assert.ok(spec, `MODEL_SPECS is missing ${CANONICAL}`);
  assert.equal(spec.contextWindow, 1_000_000);
  // The bare id must NOT gain its own spec entry — a second source of truth for the
  // same model is what lets the two ids drift apart again.
  assert.equal(MODEL_SPECS[BARE], undefined);
});

test("chatCore lifecycle resolution honors each provider catalog", () => {
  const providerModels = new Map([
    ["qwen-cloud-token-plan", BARE],
    ["qwen-web", BARE],
    ["qoder", CANONICAL],
    ["bailian-coding-plan", CANONICAL],
  ]);

  for (const [provider, expectedModel] of providerModels) {
    const [resolvedModel, effectiveModel, lifecycleError] = resolveLifecycle(provider, BARE);
    assert.equal(resolvedModel, expectedModel, `resolvedModel for ${provider}`);
    assert.equal(effectiveModel, expectedModel, `effectiveModel for ${provider}`);
    assert.equal(lifecycleError, null, `unexpected lifecycle rejection for ${provider}`);
  }
});
