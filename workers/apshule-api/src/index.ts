import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiError } from "./db.js";
import authRoutes from "./routes/auth-routes.js";
import contentRoutes from "./routes/content.js";
import eventsRoutes from "./routes/events.js";
import paymentsRoutes from "./routes/payments.js";
import platformSettingsRoutes from "./routes/platform-settings.js";
import subscriptionPlansRoutes from "./routes/subscription-plans.js";
import schoolsRoutes from "./routes/schools.js";
import settingsRoutes from "./routes/settings.js";
import platformRoutes from "./routes/platform.js";
import impersonationRoutes from "./routes/impersonation.js";
import usersRoutes from "./routes/users.js";
import userProfileRoutes from "./routes/user-profile.js";
import schoolBrandingRoutes from "./routes/school-branding.js";
import ncdcFoundationRoutes from "./routes/ncdc-foundation.js";
import ncdcLearningRoutes from "./routes/ncdc-learning.js";
import ncdcTeacherRoutes from "./routes/ncdc-teacher.js";
import reportCardsRoutes from "./routes/report-cards.js";
import bulkImportRoutes from "./routes/bulk-import.js";
import retoolingRoutes from "./routes/retooling.js";
import earningsRoutes from "./routes/earnings.js";
import mfiRoutes from "./routes/mfi.js";
import mfiCollateralRoutes from "./routes/mfi-collateral.js";
import mfiLoansRoutes from "./routes/mfi-loans.js";
import mfiLoanServicingRoutes, { runMfiOverdueSweep } from "./routes/mfi-loan-servicing.js";
import mfiReportsRoutes from "./routes/mfi-reports.js";
import mfiUmraRoutes from "./routes/mfi-umra.js";
import mfiLoanActionsRoutes from "./routes/mfi-loan-actions.js";
import mfiCustomerPortalRoutes from "./routes/mfi-customer-portal.js";
import clinicRoutes from "./routes/clinic.js";
import clinicPatientPortalRoutes from "./routes/clinic-patient-portal.js";
import documentRoutes from "./routes/documents.js";
import type { AppEnv, Env } from "./types.js";

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
    allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "Range"],
    exposeHeaders: ["Content-Length", "Content-Type"],
  }),
);
app.use(
  "/api",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "Range"],
    exposeHeaders: ["Content-Length", "Content-Type"],
  }),
);

app.get("/api/healthz", (c) =>
  c.json({ status: "ok", service: "apshule-api" }),
);
app.route("/api/auth", authRoutes);
app.route("/api/users", usersRoutes);
app.route("/api/users", userProfileRoutes);
app.route("/api/schools", schoolsRoutes);
app.route("/api/school", schoolBrandingRoutes);
app.route("/api/events", eventsRoutes);
app.route("/api", contentRoutes);
app.route("/api", documentRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api", platformRoutes);
app.route("/api", impersonationRoutes);
app.route("/api", ncdcFoundationRoutes);
app.route("/api", ncdcLearningRoutes);
app.route("/api", ncdcTeacherRoutes);
app.route("/api", reportCardsRoutes);
app.route("/api", bulkImportRoutes);
app.route("/api", retoolingRoutes);
app.route("/api", earningsRoutes);
app.route("/api", mfiRoutes);
app.route("/api", mfiCollateralRoutes);
app.route("/api", mfiLoansRoutes);
app.route("/api", mfiLoanServicingRoutes);
app.route("/api", mfiReportsRoutes);
app.route("/api", mfiUmraRoutes);
app.route("/api", mfiLoanActionsRoutes);
app.route("/api", mfiCustomerPortalRoutes);
app.route("/api", clinicRoutes);
app.route("/api", clinicPatientPortalRoutes);
app.route("/api/yopayments", paymentsRoutes);
app.route("/api/superadmin/platform-settings", platformSettingsRoutes);
app.route("/api/subscription-plans", subscriptionPlansRoutes);

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

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runMfiOverdueSweep(env));
  },
};