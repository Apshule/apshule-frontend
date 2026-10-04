import { Hono } from "hono";
import { getDb } from "../db.js";
import type { AppEnv } from "../types.js";

const subscriptionPlans = new Hono<AppEnv>();

subscriptionPlans.get("/", async (c) => {
  const sql = getDb(c.env);
  const plans = await sql`
    SELECT code, name, price, currency, duration_days, display_order
    FROM subscription_plans
    WHERE active = TRUE
    ORDER BY display_order ASC, code ASC
  `;
  return c.json({ plans });
});

export default subscriptionPlans;