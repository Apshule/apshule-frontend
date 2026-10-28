import type { Env } from "./types.js";

const ACCEPTED_STATUS_CODES = new Set([100, 101, 102]);

export function formatUgandanPhoneNumber(phone: string): string {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/gu, "");

  if (/^0\d{9}$/u.test(digits)) return `+256${digits.slice(1)}`;
  if (/^256\d{9}$/u.test(digits)) return `+${digits}`;
  if (/^\d{9}$/u.test(digits)) return `+256${digits}`;
  return trimmed;
}

function providerRejected(responseBody: unknown): boolean {
  if (!responseBody || typeof responseBody !== "object") return false;
  const smsData = (responseBody as Record<string, unknown>).SMSMessageData;
  if (!smsData || typeof smsData !== "object") return false;
  const recipients = (smsData as Record<string, unknown>).Recipients;
  if (!Array.isArray(recipients) || recipients.length === 0) return false;

  return recipients.some((recipient) => {
    if (!recipient || typeof recipient !== "object") return true;
    const entry = recipient as Record<string, unknown>;
    const code = Number(entry.statusCode);
    if (Number.isFinite(code)) return !ACCEPTED_STATUS_CODES.has(code);
    return typeof entry.status === "string" && entry.status.toLowerCase() !== "success";
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
  const username = env.AFRICASTALKING_USERNAME;
  if (!apiKey || !username) {
    throw new Error("Africa's Talking SMS is not configured.");
  }

  const formattedPhone = formatUgandanPhoneNumber(phone);
  const body = new URLSearchParams({
    username,
    to: formattedPhone,
    message: `Your Apshule OTP is: ${otp}`,
  });
  const response = await fetch("https://api.africastalking.com/version1/messaging", {
    method: "POST",
    headers: {
      apiKey,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const responseBody = await response.text();
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(responseBody);
  } catch {
    parsedBody = null;
  }

  if (!response.ok || providerRejected(parsedBody)) {
    const safeResponseBody = redactProviderResponse(responseBody, [
      apiKey,
      phone,
      formattedPhone,
      otp,
    ]);
    console.error(
      "Africa's Talking SMS provider error",
      JSON.stringify({ httpStatus: response.status, response: safeResponseBody }),
    );
    throw new Error("SMS delivery failed.");
  }
}
