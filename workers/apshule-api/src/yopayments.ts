import { ApiError, requireEnv } from "./db.js";
import type { Env } from "./types.js";

export type YoFields = Record<string, string>;

function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function normalizeFields(fields: Record<string, unknown>): YoFields {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      normalizeFieldName(key),
      value === null || value === undefined
        ? ""
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value),
    ]),
  );
}

export interface YoRequest {
  amount: number;
  account: string;
  narrative: string;
  phone: string;
  reference: string;
  ipnUrl: string;
}

export function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/gu, "");
  const normalized = digits.startsWith("0")
    ? `256${digits.slice(1)}`
    : digits.startsWith("256")
      ? digits
      : `256${digits}`;
  if (!/^256\d{9}$/u.test(normalized)) {
    throw new ApiError(400, "INVALID_PHONE", "Add a valid Ugandan mobile number to your profile.");
  }
  return normalized;
}

export interface YoApiResponse {
  ok: boolean;
  status: number;
  raw: string;
  parsed: YoFields;
}

export interface YoSettingsFallback {
  api_username?: string;
  api_password?: string;
  base_url?: string;
}

export type YoSettingsFallbackResolver = () => Promise<YoSettingsFallback>;

function buildRequestXml(
  username: string,
  password: string,
  method: string,
  fields: Record<string, string | number>,
): string {
  const body = Object.entries({
    APIUsername: username,
    APIPassword: password,
    Method: method,
    ...fields,
  })
    .map(([name, value]) => `<${name}>${xmlEscape(String(value))}</${name}>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<AutoCreate>
  <Request>${body}</Request>
</AutoCreate>`;
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .trim();
}

export function parseXmlFields(xml: string): YoFields {
  const fields: YoFields = {};
  const element = /(?=<(?:[\w.-]+:)?([\w.-]+)\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?\1\s*>)/gu;
  for (const match of xml.matchAll(element)) {
    const localName = match[1];
    const rawValue = match[2];
    if (!localName || !rawValue || /<[A-Za-z_]/u.test(rawValue)) continue;
    fields[localName.toLowerCase().replace(/[^a-z0-9]/gu, "")] = decodeXml(rawValue);
  }
  return fields;
}

export function parseIpnPayload(raw: string, contentType: string | undefined): YoFields {
  if (contentType?.toLowerCase().includes("application/json")) {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiError(400, "INVALID_IPN", "The IPN payload must be an object.");
    }
    return normalizeFields(parsed as Record<string, unknown>);
  }
  if (contentType?.toLowerCase().includes("application/x-www-form-urlencoded")) {
    return normalizeFields(Object.fromEntries(new URLSearchParams(raw).entries()));
  }
  return parseXmlFields(raw);
}

export function findYoField(
  fields: YoFields,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const normalizedName = normalizeFieldName(name);
    const value =
      fields[normalizedName] ??
      Object.entries(fields).find(([key]) => normalizeFieldName(key) === normalizedName)?.[1];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

async function sendYoRequest(
  env: Env,
  endpoint: "acdepositfunds" | "actransactioncheckstatus",
  fields: Record<string, string | number>,
  resolveFallback?: YoSettingsFallbackResolver,
): Promise<YoApiResponse> {
  const settings = resolveFallback ? await resolveFallback() : undefined;

  const username = requireEnv(
    settings ? settings.api_username : env.YO_API_USERNAME?.trim(),
    "YO_API_USERNAME",
  );
  const password = requireEnv(
    settings ? settings.api_password : env.YO_API_PASSWORD?.trim(),
    "YO_API_PASSWORD",
  );
  const baseUrl = requireEnv(
    settings ? settings.base_url : env.YO_BASE_URL?.trim() || env.YO_API_URL?.trim(),
    "YO_BASE_URL or YO_API_URL",
  );

  let url: URL;
  try {
    url = new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  } catch {
    throw new ApiError(503, "INVALID_CONFIGURATION", "YO_BASE_URL or YO_API_URL must be a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new ApiError(503, "INVALID_CONFIGURATION", "The Yo! API base URL must use HTTPS.");
  }

  const credentials = btoa(`${username}:${password}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let response: Response;
  let responseText: string;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "text/xml",
        Accept: "text/xml",
      },
      body: buildRequestXml(username, password, endpoint, fields),
      signal: controller.signal,
    });
    responseText = await response.text();
  } catch {
    throw new ApiError(502, "YO_REQUEST_FAILED", "Yo Payments could not be reached.");
  } finally {
    clearTimeout(timeout);
  }

  const parsed = parseXmlFields(responseText);
  const fault = findYoField(parsed, "faultstring", "error", "errormessage");
  const apiStatus = findYoField(parsed, "status", "result")?.toLowerCase();
  const rejectedStatus =
    apiStatus && /^(error|failed|failure|rejected|invalid|denied)$/u.test(apiStatus);
  return {
    ok: response.ok && Object.keys(parsed).length > 0 && !fault && !rejectedStatus,
    status: response.status,
    raw: responseText,
    parsed,
  };
}

export function initiateDeposit(
  env: Env,
  input: YoRequest,
  resolveFallback?: YoSettingsFallbackResolver,
): Promise<YoApiResponse> {
  return sendYoRequest(env, "acdepositfunds", {
    NonBlocking: "FALSE",
    Amount: input.amount,
    Account: input.account,
    Narrative: input.narrative,
    Phone: input.phone,
    ExternalReference: input.reference,
    InstantNotificationUrl: input.ipnUrl,
  }, resolveFallback);
}

export function checkStatus(
  env: Env,
  input: { transactionRef: string },
  resolveFallback?: YoSettingsFallbackResolver,
): Promise<YoApiResponse> {
  return sendYoRequest(env, "actransactioncheckstatus", {
    PrivateTransactionReference: input.transactionRef,
  }, resolveFallback);
}

export function normalizedYoStatus(fields: YoFields): "success" | "failed" | "pending" {
  const status = findYoField(
    fields,
    "transactionstatus",
    "paymentstatus",
    "transactionstate",
    "status",
    "state",
    "result",
  )?.toLowerCase();
  if (status && /^(success|successful|succeeded|completed|complete|paid|approved|ok)$/u.test(status)) {
    return "success";
  }
  if (
    status &&
    /^(failed|failure|rejected|cancelled|canceled|expired|declined|error)$/u.test(status)
  ) {
    return "failed";
  }
  return "pending";
}