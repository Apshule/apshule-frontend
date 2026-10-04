import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import foundationRoutes from "../src/routes/ncdc-foundation.ts";

const linkId = "6b526215-ac6e-4b89-9d5e-298c53f0551d";
const syllabusUrl = "https://ncdc.go.ug/wp-content/uploads/2024/agriculture-al.pdf";
const learnerBookUrl = "https://elearn.ncdc.go.ug/viewer/agri-al-s5";
const maxLengthUrl = `https://example.test/${"a".repeat(478)}`;

const app = new Hono();
app.onError((error, c) =>
  c.json(
    { error: error.code ?? "INTERNAL_ERROR", message: error.message },
    error.status ?? 500,
  ),
);
app.route("/", foundationRoutes);

function makeEnv(handler) {
  const statements = [];
  return {
    statements,
    env: {
      __sql: async (parts, ...values) => {
        const statement = { text: parts.join("?"), values };
        statements.push(statement);
        return handler(statement);
      },
    },
  };
}

function jsonRequest(method, body, role = "superadmin") {
  return {
    method,
    headers: {
      "content-type": "application/json",
      "x-test-role": role,
    },
    body: JSON.stringify(body),
  };
}

test("GET curriculum-link detail returns the stored book URLs", async () => {
  const link = {
    id: linkId,
    topic: "A' level construct, production, activity",
    syllabus_url: syllabusUrl,
    learner_book_url: learnerBookUrl,
    teacher_guide_url: null,
  };
  const { env, statements } = makeEnv(() => [link]);
  const response = await app.request(`/curriculum-links/${linkId}`, {}, env);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.link, link);
  assert.match(statements[0].text, /syllabus_url, learner_book_url, teacher_guide_url/u);
});

test("POST and PATCH accept valid HTTPS URLs and return them", async () => {
  const returnedLink = {
    id: linkId,
    syllabus_url: syllabusUrl,
    learner_book_url: learnerBookUrl,
    teacher_guide_url: maxLengthUrl,
  };
  const createDb = makeEnv(() => [returnedLink]);
  const createResponse = await app.request(
    "/curriculum-links",
    jsonRequest("POST", {
      syllabus_url: syllabusUrl,
      learner_book_url: learnerBookUrl,
      teacher_guide_url: maxLengthUrl,
    }),
    createDb.env,
  );
  assert.equal(createResponse.status, 201);
  assert.deepEqual((await createResponse.json()).link, returnedLink);
  assert.match(createDb.statements[0].text, /syllabus_url, learner_book_url, teacher_guide_url/u);
  assert.ok(createDb.statements[0].values.includes(syllabusUrl));
  assert.ok(createDb.statements[0].values.includes(learnerBookUrl));
  assert.ok(createDb.statements[0].values.includes(maxLengthUrl));

  const updateDb = makeEnv(() => [returnedLink]);
  const updateResponse = await app.request(
    `/curriculum-links/${linkId}`,
    jsonRequest("PATCH", {
      syllabus_url: syllabusUrl,
      learner_book_url: learnerBookUrl,
      teacher_guide_url: maxLengthUrl,
    }),
    updateDb.env,
  );
  assert.equal(updateResponse.status, 200);
  assert.deepEqual((await updateResponse.json()).link, returnedLink);
  assert.match(updateDb.statements[0].text, /syllabus_url = CASE/u);
  assert.ok(updateDb.statements[0].values.includes(syllabusUrl));
  assert.ok(updateDb.statements[0].values.includes(learnerBookUrl));
  assert.ok(updateDb.statements[0].values.includes(maxLengthUrl));
});

test("POST and PATCH reject insecure or 500-character URLs before writing", async () => {
  for (const [method, path, body] of [
    ["POST", "/curriculum-links", { syllabus_url: "http://ncdc.go.ug/book" }],
    ["PATCH", `/curriculum-links/${linkId}`, { learner_book_url: "http://ncdc.go.ug/book" }],
    ["POST", "/curriculum-links", { teacher_guide_url: `https://${"a".repeat(492)}` }],
  ]) {
    let queryCount = 0;
    const env = { __sql: async () => { queryCount++; return []; } };
    const response = await app.request(path, jsonRequest(method, body), env);
    const result = await response.json();
    assert.equal(response.status, 400);
    assert.equal(result.error, "VALIDATION_ERROR");
    assert.equal(queryCount, 0);
  }
});

test("Teacher curriculum-list responses do not include URL values", async () => {
  const queries = [];
  const env = {
    __sql: async (parts) => {
      const text = parts.join("?");
      queries.push(text);
      if (text.includes("COUNT(*)::int AS total")) return [{ total: 1 }];
      return [{
        id: linkId,
        topic: "A' level construct, production, activity",
        url_count: 2,
      }];
    },
  };
  const response = await app.request(
    "/curriculum-links?q=construct",
    { headers: { "x-test-role": "teacher" } },
    env,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.results[0].url_count, 2);
  assert.equal(JSON.stringify(body).includes(syllabusUrl), false);
  assert.equal(JSON.stringify(body).includes(learnerBookUrl), false);
  assert.equal(queries.length, 2);
});