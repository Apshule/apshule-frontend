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
    (specifier === "./db.js" && context.parentURL?.endsWith("/src/yopayments.ts")) ||
    (specifier === "../db.js" && context.parentURL?.endsWith("/src/routes/payments.ts"))
  ) {
    return virtualModule(dbStub);
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