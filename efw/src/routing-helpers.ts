import {
  DeepSpamFilter,
  investigationSkipReason,
  shouldBlockAsSpam,
  shouldInvestigateReport,
} from "./gate.js";
import { SPAM_GATE_CONFIG } from "./bundled-config.js";

type ResendEnv = {
  RESEND_API_KEY: string;
  MAIL_FROM: string;
};

export type ResendMailConfig = {
  resendApiKey: string;
  mailFrom: string;
  adminToEmail: string;
};

type SendResendEmailInput = {
  to: string | string[];
  subject: string;
  text: string;
  replyTo?: string;
  requestId?: string;
};

type SendGeneralAdminEmailInput = {
  subject: string;
  text: string;
  replyTo: string;
  requestId?: string;
};

export function resendConfigFromEnv(env: ResendEnv): Omit<ResendMailConfig, "adminToEmail"> {
  return {
    resendApiKey: env.RESEND_API_KEY,
    mailFrom: env.MAIL_FROM,
  };
}

export async function sendResendEmail(
  config: Pick<ResendMailConfig, "resendApiKey" | "mailFrom">,
  input: SendResendEmailInput,
): Promise<boolean> {
  const to = Array.isArray(input.to) ? input.to : [input.to];
  const payload: Record<string, unknown> = {
    from: config.mailFrom,
    to,
    subject: input.subject,
    text: input.text,
  };

  if (input.replyTo) {
    payload.reply_to = input.replyTo;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("Resend error", { requestId: input.requestId, status: res.status, body: errText });
    return false;
  }

  return true;
}

async function sendGeneralAdminEmail(
  config: ResendMailConfig,
  input: SendGeneralAdminEmailInput,
): Promise<boolean> {
  if (!config.adminToEmail) {
    console.error("no admin inbox configured — skipping general admin email", {
      requestId: input.requestId,
      hint: "set general.contact_email in ebram.config.yaml",
    });
    return false;
  }
  return sendResendEmail(config, {
    to: config.adminToEmail,
    subject: input.subject,
    text: input.text,
    replyTo: input.replyTo,
    requestId: input.requestId,
  });
}

export type OrchestratorStatus = "accepted" | "error";

export type TriggerInvestigationResult = {
  investigationRequestId?: string;
  orchestratorStatus: OrchestratorStatus;
};

export type OrchestratorConfig = {
  bugfixagentUrl: string;
  apiAccessKey: string;
  devTestMode: boolean;
};

type OrchestratorEnv = {
  BUGFIXAGENT_URL: string;
  EBRAM_API_ACCESS_KEY: string;
};

export type RouteConfig = {
  resend: ResendMailConfig;
  orchestrator: OrchestratorConfig;
  deepSpamFilter?: DeepSpamFilter; // undefined ⇒ filter disabled
};

export type InboundMessage = {
  preparedFullText: string;
  report: string;
  replyTo: string;
  adminSubject: string;
  requestId: string;
};

export type RouteInboundResult =
  | { outcome: "spam" }
  | { outcome: "general"; adminEmailSent: boolean }
  | { outcome: "investigation"; investigation: TriggerInvestigationResult };

export function orchestratorConfigFromEnv(
  env: OrchestratorEnv,
  devTestMode = false,
): OrchestratorConfig {
  return {
    bugfixagentUrl: env.BUGFIXAGENT_URL,
    apiAccessKey: env.EBRAM_API_ACCESS_KEY,
    devTestMode,
  };
}

const DEV_TEST_MOCK_INVESTIGATION_ID = "dev-test-mock-investigation";

// Must stay ≤ the orchestrator's `message` schema maxLength (5000)
const MAX_ORCHESTRATOR_MESSAGE_CHARS = 5_000;

export async function triggerInvestigation(
  config: OrchestratorConfig,
  report: string,
  requestId?: string,
): Promise<TriggerInvestigationResult> {
  if (config.devTestMode) {
    console.log("DEV_TEST_MODE: skipping investigation trigger", {
      requestId,
      investigationRequestId: DEV_TEST_MOCK_INVESTIGATION_ID,
      report,
    });
    return {
      investigationRequestId: DEV_TEST_MOCK_INVESTIGATION_ID,
      orchestratorStatus: "accepted",
    };
  }

  let investigationRequestId: string | undefined;
  let orchestratorStatus: OrchestratorStatus = "error";

  console.log("sending investigation to orchestrator", {
    requestId,
    url: `${config.bugfixagentUrl}/investigations`,
    reportChars: report.length,
  });

  // Enforce the orchestrator's 5,000-char cap on every path (contact form + email)
  const TRUNCATION_SUFFIX = "\n\n[report truncated to fit 5000-char limit]";
  const orchestratorMessage =
    report.length > MAX_ORCHESTRATOR_MESSAGE_CHARS
      ? report.slice(0, MAX_ORCHESTRATOR_MESSAGE_CHARS - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX
      : report;
  if (orchestratorMessage !== report) {
    console.warn("investigation report truncated for orchestrator", {
      requestId,
      reportChars: report.length,
      sentChars: orchestratorMessage.length,
    });
  }

  try {
    const resp = await fetch(`${config.bugfixagentUrl}/investigations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiAccessKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: orchestratorMessage, requestId }),
    });

    if (resp.ok) {
      const body = (await resp.json()) as {
        accepted: boolean;
        investigationRequestId: string;
      };
      investigationRequestId = body.investigationRequestId;
      orchestratorStatus = "accepted";
      console.log("investigation accepted", { requestId, investigationRequestId });
    } else {
      console.error("orchestrator returned non-ok", {
        requestId,
        status: resp.status,
        text: await resp.text().catch(() => "(read failed)"),
      });
    }
  } catch (err) {
    console.error("failed to reach orchestrator", { requestId, err });
  }

  return {
    investigationRequestId,
    orchestratorStatus,
  };
}

export function contactFormInbound(
  email: string,
  message: string,
  adminSubject: string,
  requestId: string,
): InboundMessage {
  return {
    preparedFullText: message,
    report: `From: ${email}\n\n${message}`,
    replyTo: email,
    adminSubject,
    requestId,
  };
}

export function inboundEmail(
  sender: string,
  recipient: string,
  subject: string,
  bodyText: string,
  requestId: string,
): InboundMessage {
  return {
    preparedFullText: `${subject}\n${bodyText}`,
    report: [
      `From: ${sender}`,
      `To: ${recipient}`,
      `Subject: ${subject}`,
      ``,
      bodyText,
    ].join("\n"),
    replyTo: sender,
    adminSubject: `Inbound: ${subject}`,
    requestId,
  };
}

export async function routeInboundMessage(input: {
  message: InboundMessage;
  routeConfig: RouteConfig;
  onSpamBlocked?: () => Promise<void>;
}): Promise<RouteInboundResult> {
  const { message, routeConfig, onSpamBlocked } = input;

  const spamGateConfig = SPAM_GATE_CONFIG;
  const heuristicBlocked = shouldBlockAsSpam(
    message.preparedFullText,
    spamGateConfig.words,
    spamGateConfig.minMatches,
  );
  console.log("heuristic spam gate", {
    requestId: message.requestId,
    result: heuristicBlocked ? "BLOCKED" : "passed",
    wordsLoaded: spamGateConfig.words.length,
    deepSpamGate: spamGateConfig.enableDeepSpamGate ? "enabled" : "disabled",
  });
  if (heuristicBlocked) {
    await onSpamBlocked?.();
    return { outcome: "spam" };
  }

  if (spamGateConfig.enableDeepSpamGate && routeConfig.deepSpamFilter) {
    const deepSpam = await routeConfig.deepSpamFilter.detectSpam(
      message.preparedFullText,
      message.requestId,
    );
    if (deepSpam) {
      console.warn("deep spam llm filter blocked message", {
        requestId: message.requestId,
        replyTo: message.replyTo,
        // full message on purpose: blocked content is the one case where we
        // keep the raw text, so false-positive spam blocks can be reviewed.
        fullText: message.preparedFullText,
      });
      await onSpamBlocked?.();
      return { outcome: "spam" };
    }
  }

  const skipReason = investigationSkipReason(message.preparedFullText);
  console.log("investigation eligibility gate", {
    requestId: message.requestId,
    result: skipReason ? `skipped (${skipReason})` : "eligible",
  });
  if (!shouldInvestigateReport(message.preparedFullText)) {
    const adminEmailSent = await sendGeneralAdminEmail(routeConfig.resend, {
      subject: message.adminSubject,
      text: message.report,
      replyTo: message.replyTo,
      requestId: message.requestId,
    });
    return { outcome: "general", adminEmailSent };
  }

  const investigation = await triggerInvestigation(
    routeConfig.orchestrator,
    message.report,
    message.requestId,
  );

  return { outcome: "investigation", investigation };
}
