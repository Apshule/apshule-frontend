import { Hono } from "hono";
import { authMiddleware } from "../auth.js";
import { ApiError, getDb, requireEnv } from "../db.js";
import { createReportCardsTicket } from "../report-sso-ticket.js";
import type { AppEnv } from "../types.js";

const routes = new Hono<AppEnv>();
const encoder = new TextEncoder();
const reportCardsOrigin = "https://reportcards.appshule.com";

routes.post("/ticket", authMiddleware, async (c) => {
  const user = c.get("user");
  if (!["school", "school_admin", "teacher"].includes(user.role)) {
    throw new ApiError(403, "FORBIDDEN", "Report Cards are available to school admins and teachers.");
  }
  const schoolId = user.schoolId ?? null;
  if (user.sector !== "education" || (schoolId === null && user.role !== "teacher")) {
    throw new ApiError(403, "FORBIDDEN", "A school-linked Education account or an independent teacher account is required.");
  }

  let stage = "secret validation";
  try {
    const secret = encoder.encode(requireEnv(c.env.SSO_SHARED_SECRET, "SSO_SHARED_SECRET"));
    if (secret.byteLength < 32) {
      throw new ApiError(503, "INVALID_CONFIGURATION", "SSO_SHARED_SECRET must contain at least 32 bytes.");
    }

    stage = "JWT signing";
    const ticket = await createReportCardsTicket({ id: user.id, role: user.role, schoolId }, secret);

    stage = "ticket insert";
    const ticketId = crypto.randomUUID();
    await getDb(c.env)`
      INSERT INTO sso_tickets (id, ticket, user_id, expires_at)
      VALUES (${ticketId}, ${ticket}, ${user.id}, NOW() + INTERVAL '2 minutes')
    `;
    return c.json({ ticket, expires_in: 120, audience: reportCardsOrigin });
  } catch (error) {
    console.error("[report-sso] ticket issuance failed", JSON.stringify({
      stage,
      name: error instanceof Error ? error.name : "UnknownError",
    }));
    throw error;
  }
});

export default routes;
