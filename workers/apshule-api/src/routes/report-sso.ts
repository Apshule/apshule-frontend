import { Hono } from "hono";
import { authMiddleware } from "../auth.js";
import { ApiError, getDb } from "../db.js";
import type { AppEnv } from "../types.js";

const routes = new Hono<AppEnv>();
const encoder = new TextEncoder();
const reportCardsOrigin = "https://reportcards.appshule.com";

async function ticketHash(ticket: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(ticket));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

routes.post("/ticket", authMiddleware, async (c) => {
  const user = c.get("user");
  if (!["school", "school_admin", "teacher"].includes(user.role)) {
    throw new ApiError(403, "FORBIDDEN", "Report Cards are available to school admins and teachers.");
  }
  if (!user.schoolId || user.sector !== "education") {
    throw new ApiError(403, "FORBIDDEN", "A school-linked Education account is required.");
  }

  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  const ticket = btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  const hash = await ticketHash(ticket);
  await getDb(c.env)`DELETE FROM revoked_tokens WHERE expires_at <= NOW()`;
  await getDb(c.env)`
    INSERT INTO revoked_tokens (token_id, user_id, expires_at)
    VALUES (${`report-sso:${hash}`}, ${user.id}, NOW() + INTERVAL '60 seconds')
  `;
  return c.json({ ticket, expires_in: 60, audience: reportCardsOrigin });
});

// The external Report Cards backend redeems the opaque ticket server-to-server.
// DELETE ... RETURNING makes redemption atomic and single-use across Worker isolates.
routes.post("/redeem", async (c) => {
  const origin = c.req.header("Origin");
  if (origin && origin !== reportCardsOrigin) {
    throw new ApiError(403, "FORBIDDEN", "Ticket redemption origin is not allowed.");
  }
  const body = await c.req.json().catch(() => ({})) as { ticket?: unknown };
  if (typeof body.ticket !== "string" || body.ticket.length < 40 || body.ticket.length > 100) {
    throw new ApiError(400, "INVALID_TICKET", "A valid ticket is required.");
  }
  const hash = await ticketHash(body.ticket);
  const rows = await getDb(c.env)`
    DELETE FROM revoked_tokens r
    USING users u
    WHERE r.token_id = ${`report-sso:${hash}`}
      AND r.user_id = u.id
      AND r.expires_at > NOW()
      AND u.role IN ('school', 'school_admin', 'teacher')
      AND u.sector = 'education'
      AND u.school_id IS NOT NULL
    RETURNING u.id::text AS user_id, u.role, u.school_id::text AS school_id
  `;
  if (!rows.length) throw new ApiError(401, "INVALID_TICKET", "The ticket is expired or has already been used.");
  return c.json({ user_id: rows[0].user_id, role: rows[0].role, school_id: rows[0].school_id });
});

export default routes;
