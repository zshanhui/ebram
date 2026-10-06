import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";
import PostalMime from "postal-mime";
import { ENABLE_FORM_TOKEN } from "./bundled-config.js";
import { contactFormAdminSubject, workerRouteConfigFromEnv } from "./env.js";
import {
  contactFormInbound,
  inboundEmail,
  routeInboundMessage,
  sendResendEmail,
  type OrchestratorStatus,
} from "./routing-helpers.js";
import { SPAM_BLOCK_REPLY_BODY, DeepSpamFilter, countWords } from "./gate.js";
import {
  contactFormToken,
  contactTokenMatches,
  isAllowedContactCaller,
  originsFromRedirects,
} from "./contact-guard.js";

interface Env {
  BUGFIXAGENT_URL: string;
  FALLBACK_EMAIL: string;
  EBRAM_API_ACCESS_KEY: string;
  RESEND_API_KEY: string;
  CONTACT_ERROR_REDIRECT: string;
  CONTACT_SUCCESS_REDIRECT: string;
  CONTACT_FORM_ADMIN_SUBJECT?: string;
  MAIL_FROM: string;
  DEV_TEST_MODE?: string;
  AI?: Ai;
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
// Minimum word count for contact-form messages — rejects junk like "hi", "test", bare URLs
const MIN_MESSAGE_WORDS = 20;

function badRequest(msg: string) {
  return new Response(msg, { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

async function handleFallbackForward(
  message: ForwardableEmailMessage,
  fallbackEmail: string,
  input: {
    requestId?: string;
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
  if (input.requestId) {
    fwdHeaders.set("X-Bugfixagent-RequestId", input.requestId);
  }

  try {
    await message.forward(fallbackEmail, fwdHeaders);
    console.log("forwarded to fallback", {
      requestId: input.requestId,
      to: fallbackEmail,
      investigationRequestId: input.investigationRequestId,
    });
  } catch (err) {
    console.error("fallback forward failed", { requestId: input.requestId, err });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();

    // PROBE: temporary build marker to confirm a fresh deploy is live
    console.log("efw started", {
      requestId,
      buildTag: "probe-2026-09-06-1810",
      method: request.method,
      path: new URL(request.url).pathname,
    });

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const ct = request.headers.get('content-type') || '';
    if (!ct.includes('application/x-www-form-urlencoded')) {
      return badRequest('Expected application/x-www-form-urlencoded');
    }

    const body = await request.text();
    const params = new URLSearchParams(body);

    const allowedOrigins = originsFromRedirects([
      env.CONTACT_SUCCESS_REDIRECT,
      env.CONTACT_ERROR_REDIRECT,
    ]);
    if (!isAllowedContactCaller(request.headers.get("origin"), request.headers.get("referer"), allowedOrigins)) {
      console.warn("contact form rejected origin", {
        requestId,
        origin: request.headers.get("origin"),
      });
      return Response.redirect(env.CONTACT_ERROR_REDIRECT, 302);
    }

    if (ENABLE_FORM_TOKEN) {
      const expectedToken = await contactFormToken(request.url, env.MAIL_FROM);
      if (!contactTokenMatches(params.get("contact_token") || "", expectedToken)) {
        console.warn("contact form rejected token", { requestId });
        return Response.redirect(env.CONTACT_ERROR_REDIRECT, 302);
      }
    }

    const honeypot = (params.get('website') || '').trim();
    if (honeypot.length > 0) {
      return Response.redirect(env.CONTACT_SUCCESS_REDIRECT, 302);
    }

    const email = (params.get('email') || '').trim();
    const message = (params.get('message') || '').trim();

    if (!email || !message) {
      return Response.redirect(env.CONTACT_ERROR_REDIRECT, 302);
    }

    const wordCount = countWords(message);
    if (wordCount < MIN_MESSAGE_WORDS) {
      console.log("contact form message too short", { requestId, email, words: wordCount });
      return Response.redirect(env.CONTACT_ERROR_REDIRECT, 302);
    }

    if (message.length > MAX_MESSAGE) {
      return Response.redirect(env.CONTACT_ERROR_REDIRECT, 302);
    }

    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailOk) {
      return Response.redirect(env.CONTACT_ERROR_REDIRECT, 302);
    }

    const routeConfig = {
      ...workerRouteConfigFromEnv(env),
      deepSpamFilter: env.AI ? new DeepSpamFilter(env.AI) : undefined,
    };
    const result = await routeInboundMessage({
      message: contactFormInbound(email, message, contactFormAdminSubject(env), requestId),
      routeConfig,
      onSpamBlocked: async () => {
        console.warn("contact form blocked as spam", { requestId, email });
        const spamReplySent = await sendResendEmail(routeConfig.resend, {
          to: email,
          subject: "Your message was not delivered",
          text: SPAM_BLOCK_REPLY_BODY,
          requestId,
        });
        if (!spamReplySent) {
          console.error("spam block reply failed", { requestId });
        }
      },
    });

    if (result.outcome === "general" && !result.adminEmailSent) {
      return Response.redirect(env.CONTACT_ERROR_REDIRECT, 302);
    }

    return Response.redirect(env.CONTACT_SUCCESS_REDIRECT, 302);
  },

  async email(message, env: Env, _ctx) {
    const requestId = crypto.randomUUID();

    // ── Size guard ──────────────────────────────────────────────
    if (message.rawSize > MAX_SIZE_BYTES) {
      message.setReject("message too large (max 5 MiB)");
      return;
    }

    const sender = message.from;
    const recipient = message.to;
    const subject = message.headers.get("subject") || "(no subject)";

    console.log("email received", {
      requestId,
      messageId: message.headers.get("message-id"),
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
      console.error("failed to parse email body", { requestId, err });
      bodyText = "(could not parse email body)";
    }

    const routeConfig = {
      ...workerRouteConfigFromEnv(env),
      deepSpamFilter: env.AI ? new DeepSpamFilter(env.AI) : undefined,
    };
    const result = await routeInboundMessage({
      message: inboundEmail(sender, recipient, subject, bodyText, requestId),
      routeConfig,
      onSpamBlocked: async () => {
        console.warn("email blocked as spam", { requestId, from: sender, to: recipient, subject });
        await sendAutoReply(
          message,
          recipient,
          sender,
          subject,
          SPAM_BLOCK_REPLY_BODY,
          "spam block reply sent",
          { requestId },
        );
      },
    });

    if (result.outcome === "general" && !result.adminEmailSent) {
      console.error("failed to send general admin email for inbound message", {
        requestId,
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
        { requestId, investigationRequestId },
      );
    }

    await handleFallbackForward(message, env.FALLBACK_EMAIL, {
      requestId,
      investigationRequestId,
      orchestratorStatus,
      sender,
      recipient,
    });
  },
} satisfies ExportedHandler<Env>;
