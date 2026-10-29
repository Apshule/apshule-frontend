import type { Env } from "./types.js";

const ACCEPTED_STATUS_CODES = new Set([100, 101, 102]);

export function formatUgandanPhoneNumber(phone: string): string {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/gu, "");

  if (/^0\d{9}$/u.test(digits)) return `+256${digits.slice(1)}`;
  if (/^256\d{9}$/u.test(digits)) return `+${digits}`;
  if (/^\d{9}$/u.test(digits)) return `+256${digits}`;
  throw new Error("Phone number must be a valid Ugandan number.");
}

function providerRejected(responseBody: unknown): boolean {
  if (!responseBody || typeof responseBody !== "object") return true;
  const smsData = (responseBody as Record<string, unknown>).SMSMessageData;
  if (!smsData || typeof smsData !== "object") return true;
  const recipients = (smsData as Record<string, unknown>).Recipients;
  if (!Array.isArray(recipients) || recipients.length === 0) return true;

  return recipients.some((recipient) => {
    if (!recipient || typeof recipient !== "object") return true;
    const entry = recipient as Record<string, unknown>;
    const code = Number(entry.statusCode);
    if (Number.isFinite(code)) return !ACCEPTED_STATUS_CODES.has(code);
    return typeof entry.status !== "string" || entry.status.toLowerCase() !== "success";
  });
}

function redactProviderResponse(
  responseBody: string,
  values: Array<string | undefined>,
): string {
  return values.reduce<string>(
    (safeBody, value) => value ? safeBody.replaceAll(value, "[redacted]") : safeBody,
    responseBody,
  );
}

export async function sendSmsOtp(env: Env, phone: string, otp: string): Promise<void> {
  const apiKey = env.AFRICASTALKING_API_KEY;
  if (!apiKey) {
    throw new Error("Africa's Talking SMS is not configured.");
  }

  const formattedPhone = formatUgandanPhoneNumber(phone);
  const body = new URLSearchParams({
    username: "reportcards",
    to: formattedPhone,
    message: `Your OTP is: ${otp}`,
  });
  let response: Response;
  let responseBody: string;
  try {
    response = await fetch("https://api.africastalking.com/version1/messaging", {
      method: "POST",
      headers: {
        apiKey,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    responseBody = await response.text();
  } catch (error) {
    const safeError = redactProviderResponse(String(error), [
      apiKey,
      phone,
      formattedPhone,
      otp,
    ]);
    console.error("Africa's Talking SMS request failed", safeError);
    throw new Error("SMS delivery failed.");
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(responseBody);
  } catch {
    parsedBody = null;
  }

  const safeResponseBody = redactProviderResponse(responseBody, [
    apiKey,
    phone,
    formattedPhone,
    otp,
  ]);
  const logDetails = JSON.stringify({
    httpStatus: response.status,
    response: safeResponseBody,
  });

  if (!response.ok || providerRejected(parsedBody)) {
    console.error("Africa's Talking SMS provider response", logDetails);
    throw new Error("SMS delivery failed.");
  }

  console.info("Africa's Talking SMS provider response", logDetails);
}
