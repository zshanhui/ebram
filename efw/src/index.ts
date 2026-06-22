import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";
import PostalMime from "postal-mime";
import { contactFormAdminSubject, workerRouteConfigFromEnv } from "./env.js";
import {
  contactFormInbound,
  inboundEmail,
  routeInboundMessage,
  sendResendEmail,
  type OrchestratorStatus,
} from "./routing-helpers.js";
import { SPAM_BLOCK_REPLY_BODY } from "./gate.js";

interface Env {
  BUGFIXAGENT_URL: string;
  FALLBACK_EMAIL: string;
  EBRAM_API_ACCESS_KEY: string;
  RESEND_API_KEY: string;
  CONTACT_ERROR_REDIRECT: string;
  CONTACT_SUCCESS_REDIRECT: string;
  CONTACT_TO_EMAIL: string;
  CONTACT_FORM_ADMIN_SUBJECT?: string;
  MAIL_FROM: string;
  DEV_TEST_MODE?: string;
}

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MiB

async function sendAutoReply(
  message: ForwardableEmailMessage,
  recipient: string,
  sender: string,
  subject: string,
  body: string,
  logEvent: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  try {
    const msg = createMimeMessage();

    const messageId = message.headers.get("message-id");
    if (messageId) {
      msg.setHeader("In-Reply-To", messageId);
      msg.setHeader("References", messageId);
    }

    msg.setSender(recipient);
    msg.setRecipient(sender);
    msg.setSubject(`Re: ${subject}`);
    msg.addMessage({
      contentType: "text/plain",
      data: body,
    });

    await message.reply(new EmailMessage(recipient, sender, msg.asRaw()));
    console.log(logEvent, { sender, ...meta });
  } catch (err) {
    // reply() throws if DMARC is invalid or no-reply sender — non-fatal
    console.warn("auto-reply skipped (DMARC or no-reply)", { logEvent, err });
  }
}

const MAX_MESSAGE = 12_000;

function badRequest(msg: string) {
  return new Response(msg, { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

async function handleFallbackForward(
  message: ForwardableEmailMessage,
  fallbackEmail: string,
  input: {
    investigationRequestId?: string;
    orchestratorStatus: OrchestratorStatus;
    sender: string;
    recipient: string;
  },
): Promise<void> {
  if (!fallbackEmail) return;

  const fwdHeaders = new Headers();
  fwdHeaders.set(
    "X-Bugfixagent-InvestigationId",
    input.investigationRequestId ?? "orchestrator-failed",
  );
  fwdHeaders.set("X-Bugfixagent-Status", input.orchestratorStatus);
  fwdHeaders.set("X-Bugfixagent-Sender", input.sender);
  fwdHeaders.set("X-Original-Recipient", input.recipient);

  try {
    await message.forward(fallbackEmail, fwdHeaders);
    console.log("forwarded to fallback", {
      to: fallbackEmail,
      investigationRequestId: input.investigationRequestId,
    });
  } catch (err) {
    console.error("fallback forward failed", err);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const ct = request.headers.get('content-type') || '';
    if (!ct.includes('application/x-www-form-urlencoded')) {
      return badRequest('Expected application/x-www-form-urlencoded');
    }

    const body = await request.text();
    const params = new URLSearchParams(body);
    const honeypot = (params.get('website') || '').trim();
    if (honeypot.length > 0) {
      return Response.redirect(env.CONTACT_SUCCESS_REDIRECT, 302);
    }

    const email = (params.get('email') || '').trim();
    const message = (params.get('message') || '').trim();

    if (!email || !message) {
      return Response.redirect(env.CONTACT_ERROR_REDIRECT, 302);
    }

    if (message.length > MAX_MESSAGE) {
      return Response.redirect(env.CONTACT_ERROR_REDIRECT, 302);
    }

    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailOk) {
      return Response.redirect(env.CONTACT_ERROR_REDIRECT, 302);
    }

    const routeConfig = workerRouteConfigFromEnv(env);
    const result = await routeInboundMessage({
      message: contactFormInbound(email, message, contactFormAdminSubject(env)),
      routeConfig,
      onSpamBlocked: async () => {
        console.warn("contact form blocked as spam", { email });
        const spamReplySent = await sendResendEmail(routeConfig.resend, {
          to: email,
          subject: "Your message was not delivered",
          text: SPAM_BLOCK_REPLY_BODY,
        });
        if (!spamReplySent) {
          console.error("spam block reply failed");
        }
      },
    });

    if (result.outcome === "general" && !result.adminEmailSent) {
      return Response.redirect(env.CONTACT_ERROR_REDIRECT, 302);
    }

    return Response.redirect(env.CONTACT_SUCCESS_REDIRECT, 302);
  },
  async email(message, env: Env, _ctx) {
    // ── Size guard ──────────────────────────────────────────────
    if (message.rawSize > MAX_SIZE_BYTES) {
      message.setReject("message too large (max 5 MiB)");
      return;
    }

    const sender = message.from;
    const recipient = message.to;
    const subject = message.headers.get("subject") || "(no subject)";

    console.log("email received", {
      from: sender,
      to: recipient,
      subject,
      size: message.rawSize,
    });

    // ── Parse MIME body ─────────────────────────────────────────
    let bodyText = "";
    try {
      const parsed = await PostalMime.parse(message.raw);
      bodyText = parsed.text || parsed.html || "(empty body)";
    } catch (err) {
      console.error("failed to parse email body", err);
      bodyText = "(could not parse email body)";
    }

    const routeConfig = workerRouteConfigFromEnv(env);
    const result = await routeInboundMessage({
      message: inboundEmail(sender, recipient, subject, bodyText),
      routeConfig,
      onSpamBlocked: async () => {
        console.warn("email blocked as spam", { from: sender, to: recipient, subject });
        await sendAutoReply(
          message,
          recipient,
          sender,
          subject,
          SPAM_BLOCK_REPLY_BODY,
          "spam block reply sent",
        );
      },
    });

    if (result.outcome === "general" && !result.adminEmailSent) {
      console.error("failed to send general admin email for inbound message", {
        sender,
        subject,
      });
    }

    if (result.outcome !== "investigation") {
      return;
    }

    const { investigationRequestId, orchestratorStatus } = result.investigation;

    if (orchestratorStatus === "accepted") {
      await sendAutoReply(
        message,
        recipient,
        sender,
        subject,
        [
          `Bug report received — thank you.`,
          ``,
          `We've opened an investigation and will follow up if we confirm the issue exist`,
          ``,
          investigationRequestId
            ? `Reference: ${investigationRequestId}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
        "auto-reply sent",
        { investigationRequestId },
      );
    }

    await handleFallbackForward(message, env.FALLBACK_EMAIL, {
      investigationRequestId,
      orchestratorStatus,
      sender,
      recipient,
    });
  },
} satisfies ExportedHandler<Env>;
