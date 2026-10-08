const dbStub = `
  export class ApiError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  export function getDb(env) { return env.__sql; }
  export function isUniqueViolation() { return false; }
  export function requireEnv(value, name) {
    if (!value) throw new ApiError(503, "MISSING_CONFIGURATION", name);
    return value;
  }
`;

function virtualModule(source) {
  return {
    url: `data:text/javascript,${encodeURIComponent(source)}`,
    shortCircuit: true,
  };
}

export async function resolve(specifier, context, nextResolve) {
  if (
    (
      specifier === "./db.js" &&
      /\/src\/(idempotency|yopayments|yo-platform-settings|platform-settings-crypto|ncdc-helpers|http|farm-commerce-shared)\.ts$/u.test(
        context.parentURL ?? "",
      )
    ) ||
    (
      specifier === "../db.js" &&
       /\/src\/routes\/(payments|platform-settings|ncdc-foundation|documents|clinic|clinic-workflows|clinic-pharmacy|clinic-billing|clinic-billing-shared|clinic-settlements|clinic-patient-portal|farm|farm-operations|farm-commerce|farm-facilities|farm-reports|video-studio|virtual-lab)\.ts$/u.test(
        context.parentURL ?? "",
      )
    )
  ) {
    return virtualModule(dbStub);
  }
  if (
    specifier === "../auth.js" &&
    context.parentURL?.endsWith("/src/routes/video-studio.ts")
  ) {
    return virtualModule(`
      export const authMiddleware = async (c, next) => {
        if (c.req.header("authorization") !== "Bearer test-token") {
          return c.json({ error: "UNAUTHORIZED" }, 401);
        }
        c.set("user", {
          id: "00000000-0000-4000-8000-000000000123",
          name: "Video test user",
          email: "video-test@example.test",
          role: c.req.header("x-test-role") || "teacher",
          sector: c.req.header("x-test-sector") || "education",
          schoolId: c.req.header("x-test-school") || null,
          impersonatedBy: null
        });
        await next();
      };
    `);
  }
  if (
    specifier === "../auth.js" &&
    context.parentURL?.endsWith("/src/routes/virtual-lab.ts")
  ) {
    return virtualModule(`
      export const authMiddleware = async (c, next) => {
        if (c.req.header("authorization") !== "Bearer test-token") {
          return c.json({ error: "UNAUTHORIZED" }, 401);
        }
        c.set("user", {
          id: "00000000-0000-4000-8000-000000000123",
          name: "Lab test user",
          email: "lab-test@example.test",
          role: c.req.header("x-test-role") || "teacher",
          sector: "education",
          schoolId: c.req.header("x-test-school") || null,
          impersonatedBy: null
        });
        await next();
      };
    `);
  }
  if (
    specifier === "../auth.js" &&
    /\/src\/routes\/farm(-operations|-commerce|-facilities|-reports)?\.ts$/u.test(context.parentURL ?? "")
  ) {
    return virtualModule(`
      export const authMiddleware = async (c, next) => {
        if (c.req.header("authorization") !== "Bearer test-token") {
          return c.json({ error: "UNAUTHORIZED" }, 401);
        }
        c.set("user", {
          id: "00000000-0000-4000-8000-000000000123",
          name: "Farm test user",
          email: "farm-test@example.test",
          role: c.req.header("x-test-role") || "farm_admin",
          sector: c.req.header("x-test-sector") || "farm",
          impersonatedBy: c.req.header("x-test-impersonated") || null
        });
        await next();
      };
      export async function hashPassword() { return "test-password-hash"; }
      export function requireRole(...roles) {
        return async (c, next) => {
          if (!roles.includes(c.get("user")?.role)) return c.json({ error: "FORBIDDEN" }, 403);
          await next();
        };
      }
      export function requireRealSuperAdmin() {
        return async (c, next) => {
          const user = c.get("user");
          if (user.role !== "superadmin" || user.impersonatedBy) {
            return c.json({ error: "FORBIDDEN" }, 403);
          }
          await next();
        };
      }
    `);
  }
  if (
    specifier === "../auth.js" &&
    context.parentURL?.endsWith("/src/routes/payments.ts")
  ) {
    return virtualModule(`
      export const authMiddleware = async (c, next) => next();
    `);
  }
  if (
    specifier === "../auth.js" &&
    context.parentURL?.endsWith("/src/routes/documents.ts")
  ) {
    return virtualModule(`
      export const authMiddleware = async (c, next) => {
        if (c.req.header("authorization") !== "Bearer test-token") {
          return c.json({ error: "Unauthorized" }, 401);
        }
        c.set("user", {
          id: "00000000-0000-4000-8000-000000000123",
          role: c.req.header("x-test-role") || "teacher",
          sector: "education",
          impersonatedBy: c.req.header("x-test-impersonated") || null
        });
        await next();
      };
      export function requireRealSuperAdmin() {
        return async (c, next) => {
          const user = c.get("user");
          if (user?.role !== "superadmin" || user.impersonatedBy) {
            return c.json({ error: "FORBIDDEN" }, 403);
          }
          await next();
        };
      }
    `);
  }
  if (
    specifier === "../db.js" &&
    context.parentURL?.endsWith("/src/routes/user-settings.ts")
  ) {
    return virtualModule(`
      export function getDb(env) {
        if (typeof env?.__sql !== "function") throw new Error("Missing test SQL stub.");
        return env.__sql;
      }
    `);
  }
  if (
    specifier === "../auth.js" &&
    context.parentURL?.endsWith("/src/routes/user-settings.ts")
  ) {
    return virtualModule(`
      export const authMiddleware = async (c, next) => {
        c.set("user", {
          id: "00000000-0000-4000-8000-000000000123",
          name: "Test User",
          email: "test@example.test",
          role: c.req.header("x-test-role") || "farm_admin",
          sector: c.req.header("x-test-sector") || "farm",
          impersonatedBy: c.req.header("x-test-impersonated") || null
        });
        await next();
      };
      export function requireRealSuperAdmin() {
        return async (c, next) => {
          const user = c.get("user");
          if (user.role !== "superadmin" || user.impersonatedBy) {
            return c.json({ error: "FORBIDDEN" }, 403);
          }
          await next();
        };
      }
    `);
  }
  if (
    specifier === "../auth.js" &&
    context.parentURL?.endsWith("/src/routes/platform-settings.ts")
  ) {
    return virtualModule(`
      export const authMiddleware = async (c, next) => {
        c.set("user", {
          id: "00000000-0000-4000-8000-000000000123",
          role: c.req.header("x-test-role") || "superadmin",
          sector: "education",
          impersonatedBy: c.req.header("x-test-impersonated") || null
        });
        await next();
      };
      export function requireRealSuperAdmin() {
        return async (c, next) => {
          const user = c.get("user");
          if (user.role !== "superadmin" || user.impersonatedBy) {
            return c.json({ error: "FORBIDDEN" }, 403);
          }
          await next();
        };
      }
    `);
  }
  if (
    specifier === "../auth.js" &&
    context.parentURL?.endsWith("/src/routes/ncdc-foundation.ts")
  ) {
    return virtualModule(`
      export const authMiddleware = async (c, next) => {
        c.set("user", {
          id: "00000000-0000-4000-8000-000000000123",
          role: c.req.header("x-test-role") || "superadmin",
          sector: "education",
          impersonatedBy: null
        });
        await next();
      };
      export function requireRole(...roles) {
        return async (c, next) => {
          if (!roles.includes(c.get("user")?.role)) return c.json({ error: "FORBIDDEN" }, 403);
          await next();
        };
      }
    `);
  }
  if (
    specifier === "../auth.js" &&
    context.parentURL?.endsWith("/src/routes/clinic-pharmacy.ts")
  ) {
    return virtualModule(`
      export function requireRole(...roles) {
        return async (c, next) => {
          if (!roles.includes(c.get("user")?.role)) {
            return c.json({ error: "FORBIDDEN" }, 403);
          }
          await next();
        };
      }
    `);
  }
  if (
    specifier === "../auth.js" &&
    context.parentURL?.endsWith("/src/routes/clinic-billing.ts")
  ) {
    return virtualModule(`
      export async function hashPassword() { return "test-password-hash"; }
      export function requireRole(...roles) {
        return async (c, next) => {
          if (!roles.includes(c.get("user")?.role)) return c.json({ error: "FORBIDDEN" }, 403);
          await next();
        };
      }
    `);
  }
  if (
    specifier === "../auth.js" &&
    context.parentURL?.endsWith("/src/routes/clinic-settlements.ts")
  ) {
    return virtualModule(`
      export function requireRole(...roles) {
        return async (c, next) => {
          if (!roles.includes(c.get("user")?.role)) return c.json({ error: "FORBIDDEN" }, 403);
          await next();
        };
      }
    `);
  }
  if (
    specifier === "../auth.js" &&
    context.parentURL?.endsWith("/src/routes/clinic-patient-portal.ts")
  ) {
    return virtualModule(`
      export const authMiddleware = async (c, next) => next();
      export function requireClinicPatient() {
        return async (c, next) => {
          const user = c.get("user");
          if (user?.role !== "patient" || user?.sector !== "clinic") {
            return c.json({ error: "FORBIDDEN" }, 403);
          }
          await next();
        };
      }
    `);
  }
  if (
    specifier === "../auth.js" &&
    context.parentURL?.endsWith("/src/routes/clinic.ts")
  ) {
    return virtualModule(`
      export const authMiddleware = async (c, next) => {
        if (c.req.header("authorization") !== "Bearer test-token") {
          return c.json({ error: "UNAUTHORIZED" }, 401);
        }
        c.set("user", {
          id: "00000000-0000-4000-8000-000000000123",
          name: "Clinic test user",
          email: "clinic-test@example.test",
          role: c.req.header("x-test-role") || "clinic_admin",
          sector: c.req.header("x-test-sector") || "clinic",
          impersonatedBy: c.req.header("x-test-impersonated") || null
        });
        await next();
      };
      export async function hashPassword() { return "test-password-hash"; }
      export function requireRole(...roles) {
        return async (c, next) => {
          if (!roles.includes(c.get("user")?.role)) {
            return c.json({ error: "FORBIDDEN" }, 403);
          }
          await next();
        };
      }
      export function requireRealSuperAdmin() {
        return async (c, next) => {
          const user = c.get("user");
          if (user.role !== "superadmin" || user.impersonatedBy) {
            return c.json({ error: "FORBIDDEN" }, 403);
          }
          await next();
        };
      }
    `);
  }
  if (
    specifier === "../auth.js" &&
    context.parentURL?.endsWith("/src/routes/clinic-workflows.ts")
  ) {
    return virtualModule(`
      export function requireRole(...roles) {
        return async (c, next) => {
          if (!roles.includes(c.get("user")?.role)) {
            return c.json({ error: "FORBIDDEN" }, 403);
          }
          await next();
        };
      }
    `);
  }
  if (
    specifier === "../http.js" &&
    context.parentURL?.endsWith("/src/routes/clinic-pharmacy.ts")
  ) {
    return virtualModule(`
      export async function readJson(c) { return c.req.json(); }
      export function parseLimit(raw, fallback = 100) {
        if (raw === undefined) return fallback;
        if (!/^\\\\d+$/u.test(raw)) throw new Error("Invalid limit");
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1 || value > 250) throw new Error("Invalid limit");
        return value;
      }
    `);
  }
  if (
    specifier === "../http.js" &&
    context.parentURL?.endsWith("/src/routes/payments.ts")
  ) {
    return virtualModule(`
      export async function readJson(c) { return c.req.json(); }
      export function requiredString(body, key, options = {}) {
        const value = body?.[key];
        if (typeof value !== "string" || value.length < (options.min ?? 1) ||
            value.length > (options.max ?? 1000)) {
          throw new Error("Invalid string");
        }
        return value;
      }
    `);
  }
  if (
    specifier === "../http.js" &&
    context.parentURL?.endsWith("/src/routes/documents.ts")
  ) {
    return virtualModule(`
      export async function readJson(c) { return c.req.json(); }
      export function requiredString(body, key, options = {}) {
        const value = body?.[key];
        if (typeof value !== "string" || !value.trim() ||
            value.length > (options.max ?? 1000)) {
          throw new Error("Invalid string");
        }
        return value.trim();
      }
    `);
  }
  if (
    specifier === "../http.js" &&
    context.parentURL?.endsWith("/src/routes/platform-settings.ts")
  ) {
    return virtualModule(`
      export async function readJson(c) { return c.req.json(); }
      export function optionalString(body, key, options = {}) {
        if (!(key in body)) return undefined;
        if (typeof body[key] !== "string") throw new Error("Invalid string");
        const value = body[key].trim();
        if (value.length > (options.max ?? 500)) throw new Error("String too long");
        return value;
      }
    `);
  }
  if (
    specifier === "../http.js" &&
    context.parentURL?.endsWith("/src/routes/clinic-workflows.ts")
  ) {
    return virtualModule(`
      export async function readJson(c) { return c.req.json(); }
      export function parseLimit(raw, fallback = 100) {
        if (raw === undefined) return fallback;
        if (!/^\\\\d+$/u.test(raw)) throw new Error("Invalid limit");
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1 || value > 250) throw new Error("Invalid limit");
        return value;
      }
    `);
  }
  if (
    specifier === "../http.js" &&
    /\/src\/routes\/(clinic-billing|clinic-settlements|clinic-patient-portal)\.ts$/u.test(context.parentURL ?? "")
  ) {
    return virtualModule(`
      export async function readJson(c) { return c.req.json(); }
      export function parseLimit(raw, fallback = 100) {
        if (raw === undefined) return fallback;
        if (!/^\\\\d+$/u.test(raw)) throw new Error("Invalid limit");
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1 || value > 500) throw new Error("Invalid limit");
        return value;
      }
      export function validEmail(value) {
        return typeof value === "string" && /^[^\\\\s@]+@[^\\\\s@]+\\\\.[^\\\\s@]+$/u.test(value);
      }
    `);
  }
  if (
    specifier === "../email.js" &&
    context.parentURL?.endsWith("/src/routes/farm.ts")
  ) {
    return virtualModule(`
      export async function sendEmail() { return true; }
      export function welcomeEmailTemplate(name, audience) {
        return "<p>Welcome " + name + " " + audience + "</p>";
      }
    `);
  }
  if (
    specifier === "../email.js" &&
    context.parentURL?.endsWith("/src/routes/clinic-billing.ts")
  ) {
    return virtualModule(`
      export async function sendEmail() { return true; }
      export function welcomeEmailTemplate(name, audience, url, appUrl) {
        return "<p>Welcome " + name + "</p>";
      }
    `);
  }
  if (specifier.endsWith(".js")) {
    try {
      return await nextResolve(specifier, context);
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  }
  return nextResolve(specifier, context);
}