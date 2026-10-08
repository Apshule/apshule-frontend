import { Hono } from "hono";
import { getDb } from "../db.js";
import { authMiddleware, requireRole } from "../auth.js";
import { readJson } from "../http.js";
import type { AppEnv } from "../types.js";
import en from "../i18n/en.json";
import lg from "../i18n/lg.json";
import xog from "../i18n/xog.json";
import nyn from "../i18n/nyn.json";
import nyo from "../i18n/nyo.json";
import ach from "../i18n/ach.json";
import sw from "../i18n/sw.json";

const settings = new Hono<AppEnv>();
const i18nStrings: Record<string, Record<string, string>> = {
  en, lg, xog, nyn, nyo, ach, sw,
};

settings.get("/i18n/strings", async (c) => {
  const language = c.req.query("lang") || "en";
  const strings = i18nStrings[language];
  if (!strings) return c.json({ error: "Unsupported language." }, 400);
  c.header("Cache-Control", "public, max-age=3600");
  return c.json(strings);
});

settings.get("/brand", async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`SELECT value FROM settings WHERE key = 'brand' LIMIT 1`;
  return c.json(rows[0] ? (rows[0] as { value: unknown }).value : {});
});

settings.put("/brand", authMiddleware, requireRole("superadmin"), async (c) => {
  const value = await readJson(c);
  const sql = getDb(c.env);
  const json = JSON.stringify(value);
  const rows = await sql`
    INSERT INTO settings (key, value, updated_at)
    VALUES ('brand', ${json}::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW()
    RETURNING value
  `;
  return c.json((rows[0] as { value: unknown }).value);
});

settings.get("/about", async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`SELECT value FROM settings WHERE key = 'about' LIMIT 1`;
  return c.json(rows[0] ? (rows[0] as { value: unknown }).value : {});
});

settings.put("/about", authMiddleware, requireRole("superadmin"), async (c) => {
  const value = await readJson(c);
  const sql = getDb(c.env);
  const json = JSON.stringify(value);
  const rows = await sql`
    INSERT INTO settings (key, value, updated_at)
    VALUES ('about', ${json}::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW()
    RETURNING value
  `;
  return c.json((rows[0] as { value: unknown }).value);
});

export default settings;