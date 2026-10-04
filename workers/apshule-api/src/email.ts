import { Resend } from "resend";
import type { Env } from "./types.js";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

let warnedMissingResendKey = false;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function appUrl(value?: string): string {
  try {
    const url = new URL(value || "https://appshule.com");
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin
      : "https://appshule.com";
  } catch {
    return "https://appshule.com";
  }
}

function emailFrame(title: string, content: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
  <body style="margin:0;background:#f4f2fa;font-family:Arial,sans-serif;color:#30284e">
    <div style="max-width:560px;margin:32px auto;padding:32px 24px;background:#fff;border-radius:20px">
      <p style="margin:0 0 8px;color:#6d5bb5;font-size:13px;font-weight:700;letter-spacing:1px">APSHULE</p>
      <h1 style="margin:0 0 20px;font-size:24px">${title}</h1>
      ${content}
    </div>
  </body>
</html>`;
}

export function otpEmailTemplate(name: string, otp: string): string {
  const safeName = escapeHtml(name);
  const safeOtp = escapeHtml(otp);
  return emailFrame(
    "Your password reset code",
    `<p>Hello ${safeName},</p>
     <p>Use this code to reset your APSHULE password:</p>
     <p style="margin:28px 0;text-align:center">
       <strong style="display:inline-block;padding:14px 20px;border-radius:12px;background:#f1eefb;color:#4b2e9e;font-size:32px;letter-spacing:10px">${safeOtp}</strong>
     </p>
     <p style="color:#6f6a7c">This code expires in 2 minutes. If you did not request a password reset, you can ignore this email.</p>`,
  );
}

export function welcomeEmailTemplate(
  name: string,
  role: string,
  tempPassword?: string | null,
  configuredAppUrl?: string,
): string {
  const safeName = escapeHtml(name);
  const safeRole = escapeHtml(role);
  const loginUrl = escapeHtml(appUrl(configuredAppUrl));
  const passwordBlock = tempPassword
    ? `<p>Your temporary password:</p>
       <p style="padding:12px 16px;border-radius:10px;background:#f1eefb;font-family:monospace;font-size:16px;overflow-wrap:anywhere">${escapeHtml(tempPassword)}</p>
       <p style="color:#6f6a7c">Sign in and change this password as soon as you can.</p>`
    : "";

  return emailFrame(
    "Welcome to APSHULE",
    `<p>Hello ${safeName},</p>
     <p>Your APSHULE ${safeRole} account is ready.</p>
     ${passwordBlock}
     <p><a href="${loginUrl}" style="display:inline-block;padding:12px 18px;border-radius:24px;background:#4b2e9e;color:#fff;text-decoration:none;font-weight:700">Open APSHULE</a></p>
     <p style="color:#6f6a7c">Let's learn with ease from anywhere at any time.</p>`,
  );
}

export async function sendEmail(
  env: Env,
  message: EmailMessage,
): Promise<boolean> {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    if (!warnedMissingResendKey) {
      console.warn("[email] RESEND_API_KEY is missing; email delivery skipped.");
      warnedMissingResendKey = true;
    }
    return false;
  }

  const fromEmail = env.RESEND_FROM_EMAIL?.trim() || "noreply@appshule.com";
  const fromName = (env.RESEND_FROM_NAME?.trim() || "APSHULE").replaceAll('"', "");
  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from: `${fromName} <${fromEmail}>`,
      to: message.to,
      subject: message.subject,
      html: message.html,
    });
    if (error) {
      console.warn("[email] Resend delivery failed.");
      return false;
    }
    return true;
  } catch {
    console.warn("[email] Resend delivery failed.");
    return false;
  }
}