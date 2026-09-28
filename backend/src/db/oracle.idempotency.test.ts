/**
 * Regression tests for the IdempotencyRecord empty-result path (issue #1056).
 *
 * The evidence: getIdempotencyRecord returns `result.rows[0] ?? null` — the
 * `null` branch (and by extension any caller that misinterprets it as
 * `undefined`) is the failure path that needs a stable regression suite so
 * silent behaviour changes are caught before they reach production.
 *
 * Coverage matrix
 * ───────────────
 * Empty-result / null path
 *   • getIdempotencyRecord: no row found → returns null
 * Success / happy paths
 *   • getIdempotencyRecord: row found → returns the record
 *   • storeIdempotencyRecord: inserts the row with correct params
 *   • cleanupExpiredIdempotencyKeys: deletes and returns row count
 * Boundary / error inputs
 *   • getIdempotencyRecord: empty-string key → null (no match)
 *   • getIdempotencyRecord: executor not initialised → throws
 *   • storeIdempotencyRecord: executor not initialised → throws
 *   • cleanupExpiredIdempotencyKeys: executor not initialised → throws
 *   • cleanupExpiredIdempotencyKeys: rowCount absent → returns 0
 *   • storeIdempotencyRecord: complex responseBody is JSON-serialised
 *   • storeIdempotencyRecord: numeric statusCode is preserved
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from "vitest";
import {
  getIdempotencyRecord,
  storeIdempotencyRecord,
  cleanupExpiredIdempotencyKeys,
  setOracleDbPool,
  type IdempotencyRecord,
} from "./oracle.js";
import type { Queryable } from "./markets.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

type QueryFn = Queryable["query"];

/** Build a minimal Queryable stub around a jest/vitest mock. */
function makeDb(queryMock: MockedFunction<QueryFn>): Queryable {
  return { query: queryMock } as unknown as Queryable;
}

/** Fake query result that returns exactly the given rows. */
function rowResult<T>(rows: T[], rowCount = rows.length) {
  return { rows, rowCount } as unknown as ReturnType<QueryFn> extends Promise<infer R> ? R : never;
}

// ── getIdempotencyRecord ──────────────────────────────────────────────────────

describe("getIdempotencyRecord", () => {
  it("returns null when no row is found (empty-result / line-288 path)", async () => {
    const query = vi.fn<QueryFn>().mockResolvedValue(rowResult([], 0));
    const db = makeDb(query);

    const result = await getIdempotencyRecord("missing-key", db);

    // Regression: must be strictly null, never undefined.
    expect(result).toBeNull();
    expect(result).not.toBeUndefined();
  });

  it("returns the IdempotencyRecord when a matching row exists", async () => {
    const record: IdempotencyRecord = {
      payload_hash: "abc123",
      response_body: { status: "ok" },
      status_code: 200,
    };
    const query = vi.fn<QueryFn>().mockResolvedValue(rowResult([record], 1));
    const db = makeDb(query);

    const result = await getIdempotencyRecord("known-key", db);

    expect(result).toEqual(record);
    expect(result?.payload_hash).toBe("abc123");
    expect(result?.status_code).toBe(200);
  });

  it("passes the idempotency key as the sole query parameter", async () => {
    const query = vi.fn<QueryFn>().mockResolvedValue(rowResult([], 0));
    const db = makeDb(query);

    await getIdempotencyRecord("test-key-99", db);

    expect(query).toHaveBeenCalledOnce();
    const [_sql, params] = query.mock.calls[0];
    expect(params).toEqual(["test-key-99"]);
  });

  it("returns null for an empty-string key (boundary: no row match)", async () => {
    const query = vi.fn<QueryFn>().mockResolvedValue(rowResult([], 0));
    const db = makeDb(query);

    const result = await getIdempotencyRecord("", db);

    expect(result).toBeNull();
  });

  it("throws when no executor is available (pool not initialised, no db arg)", async () => {
    // Unset the module-level pool so the fallback also fails.
    setOracleDbPool(undefined as any);

    await expect(getIdempotencyRecord("any-key")).rejects.toThrow(
      "Database pool is not initialized",
    );
  });
});

// ── storeIdempotencyRecord ────────────────────────────────────────────────────

describe("storeIdempotencyRecord", () => {
  beforeEach(() => {
    // Reset module-level pool between tests.
    setOracleDbPool(undefined as any);
  });

  it("executes an INSERT … ON CONFLICT DO NOTHING with the correct parameters", async () => {
    const query = vi.fn<QueryFn>().mockResolvedValue(rowResult([], 0));
    const db = makeDb(query);

    await storeIdempotencyRecord("idem-1", "hash-xyz", { ok: true }, 201, db);

    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0];
    expect(typeof sql).toBe("string");
    expect((sql as string).toUpperCase()).toContain("ON CONFLICT");
    expect((sql as string).toUpperCase()).toContain("DO NOTHING");
    expect(params).toEqual(["idem-1", "hash-xyz", JSON.stringify({ ok: true }), 201]);
  });

  it("JSON-serialises complex responseBody values", async () => {
    const query = vi.fn<QueryFn>().mockResolvedValue(rowResult([], 0));
    const db = makeDb(query);
    const body = { nested: { arr: [1, "two", null] }, flag: false };

    await storeIdempotencyRecord("idem-complex", "h1", body, 200, db);

    const [, params] = query.mock.calls[0];
    expect((params as unknown[])[2]).toBe(JSON.stringify(body));
  });

  it("preserves numeric statusCode exactly", async () => {
    const query = vi.fn<QueryFn>().mockResolvedValue(rowResult([], 0));
    const db = makeDb(query);

    for (const code of [200, 201, 400, 404, 409, 500]) {
      query.mockClear();
      await storeIdempotencyRecord("key", "h", {}, code, db);
      const [, params] = query.mock.calls[0];
      expect((params as unknown[])[3]).toBe(code);
    }
  });

  it("throws when no executor is available", async () => {
    await expect(storeIdempotencyRecord("key", "hash", {}, 200)).rejects.toThrow(
      "Database pool is not initialized",
    );
  });
});

// ── cleanupExpiredIdempotencyKeys ─────────────────────────────────────────────

describe("cleanupExpiredIdempotencyKeys", () => {
  beforeEach(() => {
    setOracleDbPool(undefined as any);
  });

  it("returns the number of deleted rows", async () => {
    const query = vi.fn<QueryFn>().mockResolvedValue({ rows: [], rowCount: 7 } as any);
    const db = makeDb(query);

    const deleted = await cleanupExpiredIdempotencyKeys(3600, db);

    expect(deleted).toBe(7);
  });

  it("returns 0 when rowCount is absent (boundary: mock without rowCount)", async () => {
    const query = vi.fn<QueryFn>().mockResolvedValue({ rows: [] } as any);
    const db = makeDb(query);

    const deleted = await cleanupExpiredIdempotencyKeys(3600, db);

    expect(deleted).toBe(0);
  });

  it("executes a DELETE query scoped by a cutoff timestamp", async () => {
    const query = vi.fn<QueryFn>().mockResolvedValue({ rows: [], rowCount: 0 } as any);
    const db = makeDb(query);

    const before = Date.now();
    await cleanupExpiredIdempotencyKeys(3600, db);
    const after = Date.now();

    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0];
    expect((sql as string).toUpperCase()).toContain("DELETE FROM");
    expect(Array.isArray(params)).toBe(true);

    // The cutoff date must fall within the test window.
    const cutoff = (params as unknown[])[0] as Date;
    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 3600 * 1000 - 10);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - 3600 * 1000 + 10);
  });

  it("throws when no executor is available", async () => {
    await expect(cleanupExpiredIdempotencyKeys(3600)).rejects.toThrow(
      "Database pool is not initialized",
    );
  });
});
