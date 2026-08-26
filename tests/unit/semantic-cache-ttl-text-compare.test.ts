import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { getDbInstance } from "../../src/lib/db/core.ts";
import {
  clearMemoryCache,
  getCacheStats,
  getCachedResponse,
} from "../../src/lib/semanticCache.ts";

// Regression guard for #11559.
//
// `setCachedResponse` writes `expires_at` as ISO-8601 ("…T14:00:00.000Z"), but
// the read side compared it against `datetime('now')`, which SQLite renders as
// "… 14:00:00". `expires_at` is TEXT, so the comparison is lexicographic, and
// the two spellings differ at index 10: 'T' (0x54) vs ' ' (0x20). 'T' sorts
// higher, so ANY row whose UTC calendar date is today compared greater than
// `datetime('now')` regardless of its time-of-day — it stayed live until 00:00
// UTC the next day, up to ~24h past its TTL.
//
// Every row below expires at today's UTC midnight: always the same UTC calendar
// date as "now" (so the bug is in scope) and never in the future (so a correct
// implementation must always treat it as expired). Deriving it from the current
// date rather than a fixed clock offset is deliberate — a `now - 60s` row would
// land on the previous UTC date when the suite happens to run just after
// midnight, and the test would pass against the unfixed code.
function startOfUtcTodayIso(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  ).toISOString();
}

const SIGNATURE = "sig-11559-expired-earlier-today";

function seedExpiredRow(signature: string): string {
  const expiresAt = startOfUtcTodayIso();
  const db = getDbInstance();
  db.prepare("DELETE FROM semantic_cache WHERE signature = ?").run(signature);
  db.prepare(
    `INSERT INTO semantic_cache
       (id, signature, model, prompt_hash, response, tokens_saved, hit_count, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(
    `id-${signature}`,
    signature,
    "gpt-4.1",
    signature.slice(0, 16),
    JSON.stringify({ choices: [{ message: { content: "stale" } }] }),
    7,
    expiresAt,
    expiresAt
  );
  return expiresAt;
}

describe("semantic cache honours expires_at within the same UTC day (#11559)", () => {
  before(() => {
    // Force the lazy schema bootstrap before any raw INSERT.
    getCacheStats();
  });

  beforeEach(() => {
    // The DB path is only reached on a memory miss.
    clearMemoryCache();
  });

  it("stores expires_at in a spelling that SQLite's datetime('now') misorders", () => {
    const expiresAt = startOfUtcTodayIso();
    const db = getDbInstance();
    const sqliteNow = String(
      (db.prepare("SELECT datetime('now') AS n").get() as { n: string }).n
    );

    // The precondition that makes this bug reachable, asserted rather than assumed.
    assert.equal(expiresAt.slice(0, 10), sqliteNow.slice(0, 10), "same UTC date");
    assert.equal(expiresAt[10], "T");
    assert.equal(sqliteNow[10], " ");
    assert.ok(expiresAt > sqliteNow, "the misordering the fix has to route around");
  });

  it("misses a row that expired earlier today", () => {
    seedExpiredRow(SIGNATURE);

    assert.equal(
      getCachedResponse(SIGNATURE),
      null,
      "an entry past its TTL must not be served"
    );
  });

  it("does not re-promote the expired row into the memory cache", () => {
    seedExpiredRow(SIGNATURE);
    getCachedResponse(SIGNATURE);

    // The DB hit path promotes into the LRU, so a stale hit outlives eviction
    // and restarts. A miss must leave memory empty.
    assert.equal(getCacheStats().memoryEntries, 0);
  });

  it("does not count the expired row in getCacheStats().dbEntries", () => {
    const signature = `${SIGNATURE}-stats`;
    const db = getDbInstance();
    db.prepare("DELETE FROM semantic_cache WHERE signature = ?").run(signature);

    // A delta, not an absolute: dbEntries counts every live row in the shared
    // test database, so only the change caused by this row is ours to assert.
    const before = getCacheStats().dbEntries;
    seedExpiredRow(signature);
    const after = getCacheStats().dbEntries;

    const present = db
      .prepare("SELECT COUNT(*) AS c FROM semantic_cache WHERE signature = ?")
      .get(signature) as { c: number };
    assert.equal(Number(present.c), 1, "the row is in the table, just expired");
    assert.equal(after, before, "an expired row must not count as a live entry");
  });
});
