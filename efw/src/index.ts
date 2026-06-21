import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";
import PostalMime from "postal-mime";
import {
  KEY_WORDS,
  MIN_REPORT_WORDS,
  SPAM_BLOCK_REPLY_BODY,
  countWords,
  investigationSkipReason,
  shouldBlockAsSpam,
} from "./report-gate.js";

interface Env {
  BUGFIXAGENT_URL: string;
  FALLBACK_EMAIL: string;
  EBRAM_API_ACCESS_KEY: string;
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

export default {
  async email(message, env: Env, _ctx) {
    // ── Size guard ──────────────────────────────────────────────
    if (message.rawSize > MAX_SIZE_BYTES) {
      message.setReject("Message too large (max 25 MiB)");
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

    // ── Build the bug report payload ────────────────────────────
    const report = [
      `From: ${sender}`,
      `To: ${recipient}`,
      `Subject: ${subject}`,
      ``,
      bodyText,
    ].join("\n");

    const searchableText = `${subject}\n${bodyText}`;

    if (shouldBlockAsSpam(searchableText)) {
      console.warn("email blocked as spam", { from: sender, to: recipient, subject });
      await sendAutoReply(
        message,
        recipient,
        sender,
        subject,
        SPAM_BLOCK_REPLY_BODY,
        "spam block reply sent",
      );
      return;
    }

    const skipReason = investigationSkipReason(searchableText);
    const shouldInvestigate = skipReason === null;
    const wordCount = countWords(searchableText);

    // ── Forward to bugfixagent orchestrator ─────────────────────
    let investigationRequestId: string | undefined;
    let orchestratorOk = false;
    let orchestratorStatus: "accepted" | "error" | "skipped" = shouldInvestigate
      ? "error"
      : "skipped";

    if (shouldInvestigate) {
      try {
        const resp = await fetch(`${env.BUGFIXAGENT_URL}/investigations`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.EBRAM_API_ACCESS_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ message: report }),
        });

        if (resp.ok) {
          const body = (await resp.json()) as {
            accepted: boolean;
            investigationRequestId: string;
          };
          investigationRequestId = body.investigationRequestId;
          orchestratorOk = true;
          orchestratorStatus = "accepted";
          console.log("investigation accepted", { investigationRequestId });
        } else {
          console.error("orchestrator returned non-ok", {
            status: resp.status,
            text: await resp.text().catch(() => "(read failed)"),
          });
        }
      } catch (err) {
        console.error("failed to reach orchestrator", err);
      }
    } else {
      console.log("orchestrator skipped", {
        reason: skipReason,
        requiredKeywords: KEY_WORDS,
        minWords: MIN_REPORT_WORDS,
        wordCount,
      });
    }

    // ── Auto-reply to sender ────────────────────────────────────
    if (orchestratorOk) {
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

    // ── Forward to fallback inbox ───────────────────────────────
    if (env.FALLBACK_EMAIL) {
      const fwdHeaders = new Headers();
      fwdHeaders.set(
        "X-Bugfixagent-InvestigationId",
        investigationRequestId ?? "orchestrator-failed",
      );
      fwdHeaders.set("X-Bugfixagent-Status", orchestratorStatus);
      fwdHeaders.set("X-Bugfixagent-Sender", sender);
      fwdHeaders.set("X-Original-Recipient", recipient);

      try {
        await message.forward(env.FALLBACK_EMAIL, fwdHeaders);
        console.log("forwarded to fallback", {
          to: env.FALLBACK_EMAIL,
          investigationRequestId,
        });
      } catch (err) {
        console.error("fallback forward failed", err);
      }
    }
  },
} satisfies ExportedHandler<Env>;
