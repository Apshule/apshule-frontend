import { Hono } from "hono";
import { SignJWT } from "jose";
import { authMiddleware } from "../auth.js";
import { ApiError, getDb, requireEnv } from "../db.js";
import type { AppEnv } from "../types.js";

const routes = new Hono<AppEnv>();
const encoder = new TextEncoder();
const reportCardsOrigin = "https://reportcards.appshule.com";

routes.post("/ticket", authMiddleware, async (c) => {
  const user = c.get("user");
  if (!["school", "school_admin", "teacher"].includes(user.role)) {
    throw new ApiError(403, "FORBIDDEN", "Report Cards are available to school admins and teachers.");
  }
  if (!user.schoolId || user.sector !== "education") {
    throw new ApiError(403, "FORBIDDEN", "A school-linked Education account is required.");
  }

  const secret = encoder.encode(requireEnv(c.env.SSO_SHARED_SECRET, "SSO_SHARED_SECRET"));
  if (secret.byteLength < 32) {
    throw new ApiError(503, "INVALID_CONFIGURATION", "SSO_SHARED_SECRET must contain at least 32 bytes.");
  }
  const ticket = await new SignJWT({ user_id: user.id })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(secret);
  await getDb(c.env)`
    INSERT INTO sso_tickets (id, ticket, user_id, expires_at)
    VALUES (gen_random_uuid(), ${ticket}, ${user.id}, NOW() + INTERVAL '2 minutes')
  `;
  return c.json({ ticket, expires_in: 120, audience: reportCardsOrigin });
});

export default routes;
