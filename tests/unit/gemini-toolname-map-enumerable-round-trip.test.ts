import test from "node:test";
import assert from "node:assert/strict";

const { openaiToGeminiRequest, openaiToAntigravityRequest } =
  await import("../../open-sse/translator/request/openai-to-gemini.ts");
const { claudeToGeminiRequest } =
  await import("../../open-sse/translator/request/claude-to-gemini.ts");
const { openaiToClaudeRequest } =
  await import("../../open-sse/translator/request/openai-to-claude.ts");
const { extractRequestToolIdentityMap, toToolNameAliasMap } =
  await import("../../open-sse/handlers/chatCore/requestToolIdentity.ts");
const { caseInsensitiveToolNameLookup } =
  await import("../../open-sse/translator/helpers/toolCallHelper.ts");

// Gemini/Antigravity mangled every MCP tool name and never restored it, so
// clients rejected each call with "No such tool available".
//
// `sanitizeGeminiToolName` collapses `[^a-zA-Z0-9_]` to `_` and then squashes
// runs, so `mcp__chrome-devtools__list_pages` goes on the wire as
// `mcp_chrome_devtools_list_pages`. The alias is recorded in `_toolNameMap` for
// the response translator to reverse — but the request translators below
// published it with a PLAIN assignment, i.e. an ENUMERABLE property.
//
// A `Map` has no JSON representation, so an enumerable `_toolNameMap`
//   1. serializes into the upstream request body as a bare `{}`, and
//   2. comes back from the executor's `JSON.parse(JSON.stringify(body))`
//      capture as `{}` — no longer `instanceof Map`.
//
// `extractRequestToolIdentityMap` then yields null, the response translator
// gets no map, and the mangled wire name reaches the client verbatim. Colliding
// names are worse: they arrive as an opaque `tool_<hash>`.
//
// `openai-responses.ts` already publishes the map with `Object.defineProperty(…,
// { enumerable: false })`; #4091 / #4307 fixed the same class of bug on the
// native-Claude cloak path. These translators were missed.

type GeminiToolBlock = { functionDeclarations?: { name?: string }[] };

const MCP_TOOL_NAME = "mcp__chrome-devtools__list_pages";
const GEMINI_WIRE_NAME = "mcp_chrome_devtools_list_pages";

function openaiBodyWithTool(name: string) {
  return {
    messages: [{ role: "user", content: "list the browser pages" }],
    tools: [
      {
        type: "function",
        function: {
          name,
          description: "List browser pages",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  };
}

function claudeBodyWithTool(name: string) {
  return {
    messages: [{ role: "user", content: "list the browser pages" }],
    tools: [
      {
        name,
        description: "List browser pages",
        input_schema: { type: "object", properties: {} },
      },
    ],
  };
}

function assertSideChannelSurvives(result: Record<string, unknown>, label: string) {
  assert.ok(result._toolNameMap instanceof Map, `${label}: _toolNameMap must be a Map`);

  assert.ok(
    !Object.keys(result).includes("_toolNameMap"),
    `${label}: _toolNameMap must be non-enumerable so it never re-serializes upstream`
  );

  assert.ok(
    !JSON.stringify(result).includes("_toolNameMap"),
    `${label}: _toolNameMap must not leak into the serialized upstream body`
  );

  // The executor capture rebuilds the body from its serialized form; a
  // degenerate `{}` there is what silently drops every alias.
  const captured = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
  assert.equal(
    captured._toolNameMap,
    undefined,
    `${label}: round-tripped body must not carry a degenerate {} in place of the Map`
  );
}

test("openai-to-gemini: MCP tool alias survives the executor JSON round-trip", () => {
  const result = openaiToGeminiRequest(
    "gemini-3.5-flash",
    openaiBodyWithTool(MCP_TOOL_NAME),
    false
  ) as Record<string, unknown>;

  const declared = (result.tools as GeminiToolBlock[])?.[0]?.functionDeclarations?.[0]?.name;
  assert.equal(declared, GEMINI_WIRE_NAME, "precondition: the wire name is sanitized");

  assertSideChannelSurvives(result, "openai-to-gemini");

  assert.equal(
    (result._toolNameMap as Map<string, string>).get(GEMINI_WIRE_NAME),
    MCP_TOOL_NAME,
    "openai-to-gemini: alias must map the wire name back to the caller's tool name"
  );
});

test("openai-to-gemini: chatCore recovers the alias and the response restores the tool name", () => {
  const result = openaiToGeminiRequest(
    "gemini-3.5-flash",
    openaiBodyWithTool(MCP_TOOL_NAME),
    false
  ) as Record<string, unknown>;

  // chatCore extracts the side channel from the body the executor hands back.
  const identity = extractRequestToolIdentityMap(result);
  const aliases = toToolNameAliasMap(identity as never);

  assert.ok(aliases instanceof Map, "chatCore must recover an alias map for the response path");
  assert.equal(
    caseInsensitiveToolNameLookup(GEMINI_WIRE_NAME, aliases),
    MCP_TOOL_NAME,
    "the response translator must hand the client the tool name it registered"
  );
});

test("claude-to-gemini: MCP tool alias survives the executor JSON round-trip", () => {
  const result = claudeToGeminiRequest(
    "gemini-3.5-flash",
    claudeBodyWithTool(MCP_TOOL_NAME),
    false
  ) as Record<string, unknown>;

  assertSideChannelSurvives(result, "claude-to-gemini");
  assert.equal((result._toolNameMap as Map<string, string>).get(GEMINI_WIRE_NAME), MCP_TOOL_NAME);
});

test("openai-to-antigravity: envelope alias survives the executor JSON round-trip", () => {
  // The Antigravity envelope re-publishes the inner request's ledger; it needs
  // the same non-enumerable treatment or the alias dies one layer further out.
  const result = openaiToAntigravityRequest(
    "gemini-3.5-flash",
    openaiBodyWithTool(MCP_TOOL_NAME),
    false,
    { projectId: "proj-1" } as never
  ) as Record<string, unknown>;

  assertSideChannelSurvives(result, "openai-to-antigravity");
  assert.equal((result._toolNameMap as Map<string, string>).get(GEMINI_WIRE_NAME), MCP_TOOL_NAME);
});

test("openai-to-claude: tool alias side channel is non-enumerable", () => {
  // Claude keeps `mcp__` names verbatim, so drive the alias with a name the
  // translator does have to rewrite: >64 chars is truncated with a hash.
  const longName = `mcp__chrome_devtools__${"list_pages_".repeat(6)}end`;
  assert.ok(longName.length > 64, "precondition: name is long enough to be rewritten");

  const result = openaiToClaudeRequest(
    "claude-sonnet-4-5",
    openaiBodyWithTool(longName),
    false
  ) as Record<string, unknown>;

  if (!(result._toolNameMap instanceof Map)) {
    return; // translator chose not to rewrite; nothing to protect here
  }
  assertSideChannelSurvives(result, "openai-to-claude");
});
