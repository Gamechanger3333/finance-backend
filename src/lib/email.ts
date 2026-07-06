import { Resend } from "resend";
import { logger } from "./logger.js";

const RESEND_API_KEY = process.env.RESEND_API_KEY;

if (!RESEND_API_KEY) {
  console.error("FATAL: RESEND_API_KEY environment variable is not set.");
  process.exit(1);
}

const resend = new Resend(RESEND_API_KEY);

// Resend's shared sandbox sender — works without owning/verifying a custom
// domain and can deliver to ANY real inbox. This is exactly what we want
// since we don't have a domain yet.
const FROM_ADDRESS = process.env.EMAIL_FROM || "FinFlow <onboarding@resend.dev>";

const BRAND_COLOR = "#10b981";

function wrapTemplate(opts: { preheader: string; bodyHtml: string }): string {
  return `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
  <body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <span style="display:none;font-size:1px;color:#f4f4f5;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${opts.preheader}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7;">
            <tr>
              <td style="background:${BRAND_COLOR};padding:24px 32px;">
                <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.02em;">FinFlow</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                ${opts.bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;background:#fafafa;border-top:1px solid #e4e4e7;">
                <p style="margin:0;font-size:12px;color:#a1a1aa;">If you didn't request this email, you can safely ignore it.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export async function sendVerificationEmail(opts: {
  to: string;
  name: string;
  otp: string;
  verifyUrl: string;
}): Promise<void> {
  const bodyHtml = `
    <h1 style="margin:0 0 12px;font-size:20px;color:#18181b;">Verify your email</h1>
    <p style="margin:0 0 24px;font-size:14px;color:#52525b;line-height:1.6;">
      Hi ${escapeHtml(opts.name)}, welcome to FinFlow! Confirm your email address to activate your account.
      You can either click the button below, or enter the 6-digit code in the app.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
      <tr>
        <td style="border-radius:8px;background:${BRAND_COLOR};">
          <a href="${opts.verifyUrl}" style="display:inline-block;padding:12px 28px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">
            Verify Email Address
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 8px;font-size:13px;color:#71717a;">Or enter this code in the app:</p>
    <div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#18181b;background:#f4f4f5;border-radius:8px;padding:16px;text-align:center;margin-bottom:20px;">
      ${opts.otp}
    </div>
    <p style="margin:0;font-size:12px;color:#a1a1aa;">This code and link expire in 15 minutes.</p>
  `;

  await sendMail({
    to: opts.to,
    subject: "Verify your FinFlow email address",
    html: wrapTemplate({ preheader: `Your FinFlow verification code is ${opts.otp}`, bodyHtml }),
  });
}

export async function sendPasswordResetEmail(opts: {
  to: string;
  name: string;
  otp: string;
  resetUrl: string;
}): Promise<void> {
  const bodyHtml = `
    <h1 style="margin:0 0 12px;font-size:20px;color:#18181b;">Reset your password</h1>
    <p style="margin:0 0 24px;font-size:14px;color:#52525b;line-height:1.6;">
      Hi ${escapeHtml(opts.name)}, we received a request to reset your FinFlow password.
      Click the button below, or use the 6-digit code in the app.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
      <tr>
        <td style="border-radius:8px;background:${BRAND_COLOR};">
          <a href="${opts.resetUrl}" style="display:inline-block;padding:12px 28px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">
            Reset Password
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 8px;font-size:13px;color:#71717a;">Or enter this code in the app:</p>
    <div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#18181b;background:#f4f4f5;border-radius:8px;padding:16px;text-align:center;margin-bottom:20px;">
      ${opts.otp}
    </div>
    <p style="margin:0;font-size:12px;color:#a1a1aa;">This code and link expire in 15 minutes. If you didn't request a password reset, please secure your account.</p>
  `;

  await sendMail({
    to: opts.to,
    subject: "Reset your FinFlow password",
    html: wrapTemplate({ preheader: `Your FinFlow password reset code is ${opts.otp}`, bodyHtml }),
  });
}

async function sendMail(opts: { to: string; subject: string; html: string }): Promise<void> {
  const { data, error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
  });

  if (error) {
    logger.error({ error, to: opts.to }, "Failed to send email via Resend");
    throw new Error("Failed to send email");
  }

  logger.info({ id: data?.id, to: opts.to }, "Email sent via Resend");
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
