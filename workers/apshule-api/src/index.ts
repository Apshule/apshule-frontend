import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiError } from "./db.js";
import authRoutes from "./routes/auth-routes.js";
import contentRoutes from "./routes/content.js";
import eventsRoutes from "./routes/events.js";
import paymentsRoutes from "./routes/payments.js";
import schoolsRoutes from "./routes/schools.js";
import settingsRoutes from "./routes/settings.js";
import platformRoutes from "./routes/platform.js";
import impersonationRoutes from "./routes/impersonation.js";
import usersRoutes from "./routes/users.js";
import ncdcFoundationRoutes from "./routes/ncdc-foundation.js";
import ncdcLearningRoutes from "./routes/ncdc-learning.js";
import ncdcTeacherRoutes from "./routes/ncdc-teacher.js";
import reportCardsRoutes from "./routes/report-cards.js";
import bulkImportRoutes from "./routes/bulk-import.js";
import type { AppEnv } from "./types.js";

const app = new Hono<AppEnv>();

function redactErrorText(value: string, env: AppEnv["Bindings"]): string {
  let sanitized = value;
  for (const secret of [env.DATABASE_URL, env.JWT_SECRET]) {
    if (secret) sanitized = sanitized.replaceAll(secret, "[REDACTED]");
  }
  return sanitized.replace(
    /postgres(?:ql)?:\/\/[^\s"'<>]+/giu,
    "[REDACTED DATABASE_URL]",
  );
}

function describeError(error: unknown, env: AppEnv["Bindings"]) {
  if (!(error instanceof Error)) {
    return {
      name: "NonErrorThrown",
      message: redactErrorText(String(error), env),
    };
  }

  const source = error as Error & {
    code?: unknown;
    severity?: unknown;
    schema?: unknown;
    table?: unknown;
    column?: unknown;
    constraint?: unknown;
    routine?: unknown;
    cause?: unknown;
  };
  const details: Record<string, unknown> = {
    name: error.name,
    message: redactErrorText(error.message, env),
  };

  if (error.stack) details.stack = redactErrorText(error.stack, env);
  for (const field of [
    "code",
    "severity",
    "schema",
    "table",
    "column",
    "constraint",
    "routine",
  ] as const) {
    const value = source[field];
    if (typeof value === "string" || typeof value === "number") {
      details[field] =
        typeof value === "string" ? redactErrorText(value, env) : value;
    }
  }

  if (source.cause instanceof Error) {
    details.cause = {
      name: source.cause.name,
      message: redactErrorText(source.cause.message, env),
      ...(source.cause.stack
        ? { stack: redactErrorText(source.cause.stack, env) }
        : {}),
    };
  } else if (typeof source.cause === "string") {
    details.cause = redactErrorText(source.cause, env);
  }

  return details;
}

app.use(
  "/api/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use(
  "/api",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

app.get("/api/healthz", (c) =>
  c.json({ status: "ok", service: "apshule-api" }),
);
app.route("/api/auth", authRoutes);
app.route("/api/users", usersRoutes);
app.route("/api/schools", schoolsRoutes);
app.route("/api/events", eventsRoutes);
app.route("/api", contentRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api", platformRoutes);
app.route("/api", impersonationRoutes);
app.route("/api", ncdcFoundationRoutes);
app.route("/api", ncdcLearningRoutes);
app.route("/api", ncdcTeacherRoutes);
app.route("/api", reportCardsRoutes);
app.route("/api", bulkImportRoutes);
app.route("/api/yopayments", paymentsRoutes);

app.notFound((c) =>
  c.json({ error: "Route not found." }, 404),
);

app.onError((error, c) => {
  if (error instanceof ApiError) {
    return c.json(
      { error: error.message },
      error.status as ContentfulStatusCode,
    );
  }
  console.error(
    "[apshule-api] Unhandled request error",
    JSON.stringify(describeError(error, c.env)),
  );
  return c.json({ error: "An unexpected server error occurred." }, 500);
});

export default app;