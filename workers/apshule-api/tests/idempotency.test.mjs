import assert from "node:assert/strict";
import test from "node:test";
import {
  readIdempotencyKey,
  resolveIdempotencyTransaction,
} from "../src/idempotency.ts";

const owner = {
  key: "a4ba3189-c626-48fa-b929-ef27e95ad53e",
  userId: "00000000-0000-4000-8000-000000000001",
  route: "/api/projects",
};

test("accepts UUID idempotency keys and rejects malformed or oversized keys", () => {
  assert.equal(readIdempotencyKey(owner.key), owner.key);
  assert.equal(readIdempotencyKey(null), null);
  assert.throws(() => readIdempotencyKey("key with spaces"), {
    code: "INVALID_IDEMPOTENCY_KEY",
  });
  assert.throws(() => readIdempotencyKey("x".repeat(129)), {
    code: "INVALID_IDEMPOTENCY_KEY",
  });
});

test("uses the stored response with HTTP 200 when a key was already claimed", () => {
  const body = { project: { id: 7 } };
  const result = resolveIdempotencyTransaction(
    owner,
    [],
    [],
    [{ user_id: owner.userId, route: owner.route, response_body: body }],
    201,
  );
  assert.deepEqual(result, { body, status: 200, replayed: true });
});

test("returns the first operation response and original status for a new key", () => {
  const body = { record: { id: 12 } };
  const result = resolveIdempotencyTransaction(
    owner,
    [{ key: owner.key }],
    [{ response_body: body }],
    [{ user_id: owner.userId, route: owner.route, response_body: body }],
    201,
  );
  assert.deepEqual(result, { body, status: 201, replayed: false });
});

test("rejects a key owned by another user or route", () => {
  assert.throws(
    () =>
      resolveIdempotencyTransaction(
        owner,
        [],
        [],
        [{
          user_id: "00000000-0000-4000-8000-000000000002",
          route: owner.route,
          response_body: { project: {} },
        }],
        201,
      ),
    { code: "IDEMPOTENCY_KEY_REUSED" },
  );
  assert.throws(
    () =>
      resolveIdempotencyTransaction(
        owner,
        [],
        [],
        [{
          user_id: owner.userId,
          route: "/api/ca-records",
          response_body: { record: {} },
        }],
        201,
      ),
    { code: "IDEMPOTENCY_KEY_REUSED" },
  );
});