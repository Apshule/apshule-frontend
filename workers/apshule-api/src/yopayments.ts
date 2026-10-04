import { ApiError, requireEnv } from "./db.js";
import type { Env } from "./types.js";

export type YoFields = Record<string, string>;

export interface YoRequest {
  amount: number;
  account: string;
  narrative: string;
  phone: string;
  reference: string;
  ipnUrl: string;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildSoapEnvelope(
  operation: string,
  fields: Record<string, string | number>,
): string {
  const body = Object.entries(fields)
    .map(([name, value]) => `<${name}>${escapeXml(String(value))}</${name}>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <${operation}>${body}</${operation}>
  </soapenv:Body>
</soapenv:Envelope>`;
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
  const element = /<(?:[\w.-]+:)?([\w.-]+)\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?[\w.-]+\s*>/gu;
  for (const match of xml.matchAll(element)) {
    const localName = match[1];
    const rawValue = match[2];
    if (!localName || !rawValue || /<[A-Za-z_]/u.test(rawValue)) continue;
    fields[localName.toLowerCase().replace(/[^a-z0-9]/gu, "")] = decodeXml(rawValue);
  }
  return fields;
}

export function findYoField(
  fields: YoFields,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = fields[name.toLowerCase().replace(/[^a-z0-9]/gu, "")];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

async function sendYoRequest(
  env: Env,
  endpoint: "acdepositfunds" | "actransactioncheckstatus",
  fields: Record<string, string | number>,
): Promise<YoFields> {
  const username = requireEnv(env.YO_API_USERNAME, "YO_API_USERNAME");
  const password = requireEnv(env.YO_API_PASSWORD, "YO_API_PASSWORD");
  const baseUrl = requireEnv(env.YO_API_URL, "YO_API_URL");

  let url: URL;
  try {
    url = new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  } catch {
    throw new ApiError(503, "INVALID_CONFIGURATION", "YO_API_URL must be a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new ApiError(503, "INVALID_CONFIGURATION", "YO_API_URL must use HTTPS.");
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
        "Content-Type": "text/xml; charset=utf-8",
        Accept: "text/xml",
      },
      body: buildSoapEnvelope(endpoint, fields),
      signal: controller.signal,
    });
    responseText = await response.text();
  } catch {
    throw new ApiError(502, "YO_REQUEST_FAILED", "Yo Payments could not be reached.");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new ApiError(
      502,
      "YO_REQUEST_FAILED",
      `Yo Payments returned HTTP ${response.status}.`,
    );
  }
  const parsed = parseXmlFields(responseText);
  if (Object.keys(parsed).length === 0) {
    throw new ApiError(502, "YO_INVALID_RESPONSE", "Yo Payments returned an unreadable XML response.");
  }
  const fault = findYoField(parsed, "faultstring", "error", "errormessage");
  if (fault) {
    throw new ApiError(502, "YO_REQUEST_REJECTED", "Yo Payments rejected the request.");
  }
  return parsed;
}

export function initiateDeposit(env: Env, input: YoRequest): Promise<YoFields> {
  return sendYoRequest(env, "acdepositfunds", {
    Amount: input.amount,
    Account: input.account,
    Narrative: input.narrative,
    Phone: input.phone,
    Reference: input.reference,
    IPNURL: input.ipnUrl,
  });
}

export function checkStatus(
  env: Env,
  input: { transactionRef: string },
): Promise<YoFields> {
  return sendYoRequest(env, "actransactioncheckstatus", {
    TransactionRef: input.transactionRef,
  });
}

export function normalizedYoStatus(fields: YoFields): "completed" | "failed" | "pending" {
  const status = findYoField(
    fields,
    "transactionstatus",
    "paymentstatus",
    "status",
    "state",
    "result",
  )?.toLowerCase();
  if (status && /^(success|successful|completed|complete|paid|approved)$/u.test(status)) {
    return "completed";
  }
  if (
    status &&
    /^(failed|failure|rejected|cancelled|canceled|expired|declined|error)$/u.test(status)
  ) {
    return "failed";
  }
  return "pending";
}