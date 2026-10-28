import assert from "node:assert/strict";
import test from "node:test";
import { jwtVerify } from "jose";
import { createReportCardsTicket } from "../src/report-sso-ticket.ts";

test("Report Cards SSO ticket carries the shared user identity and school role claims", async () => {
  const secret = new TextEncoder().encode("test-only-report-cards-secret-32-bytes");
  const user = {
    id: "00000000-0000-4000-8000-000000000123",
    role: "teacher",
    schoolId: "00000000-0000-4000-8000-000000000456",
  };

  const ticket = await createReportCardsTicket(user, secret);
  const { payload } = await jwtVerify(ticket, secret, { algorithms: ["HS256"] });

  assert.equal(payload.user_id, user.id);
  assert.equal(payload.sub, user.id);
  assert.equal(payload.role, user.role);
  assert.equal(payload.school_id, user.schoolId);
  assert.ok(Number(payload.exp) - Number(payload.iat) <= 120);
});

test("Report Cards SSO ticket preserves school-admin role claims", async () => {
  const secret = new TextEncoder().encode("test-only-report-cards-secret-32-bytes");
  const user = {
    id: "00000000-0000-4000-8000-000000000789",
    role: "school",
    schoolId: "00000000-0000-4000-8000-000000000456",
  };

  const ticket = await createReportCardsTicket(user, secret);
  const { payload } = await jwtVerify(ticket, secret, { algorithms: ["HS256"] });

  assert.equal(payload.user_id, user.id);
  assert.equal(payload.role, user.role);
  assert.equal(payload.school_id, user.schoolId);
});

test("Report Cards SSO ticket explicitly includes null school_id for independent teachers", async () => {
  const secret = new TextEncoder().encode("test-only-report-cards-secret-32-bytes");
  const user = {
    id: "00000000-0000-4000-8000-000000000987",
    role: "teacher",
    schoolId: null,
  };

  const ticket = await createReportCardsTicket(user, secret);
  const { payload } = await jwtVerify(ticket, secret, { algorithms: ["HS256"] });

  assert.equal(payload.user_id, user.id);
  assert.equal(payload.role, user.role);
  assert.ok(Object.hasOwn(payload, "school_id"));
  assert.equal(payload.school_id, null);
});
