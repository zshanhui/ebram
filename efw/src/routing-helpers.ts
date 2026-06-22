import { shouldBlockAsSpam, shouldInvestigateReport } from "./gate.js";

type ResendEnv = {
  RESEND_API_KEY: string;
  MAIL_FROM: string;
  CONTACT_TO_EMAIL: string;
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
};

type SendGeneralAdminEmailInput = {
  subject: string;
  text: string;
  replyTo: string;
};

export function resendConfigFromEnv(env: ResendEnv): ResendMailConfig {
  return {
    resendApiKey: env.RESEND_API_KEY,
    mailFrom: env.MAIL_FROM,
    adminToEmail: env.CONTACT_TO_EMAIL,
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
    console.error("Resend error", res.status, errText);
    return false;
  }

  return true;
}

async function sendGeneralAdminEmail(
  config: ResendMailConfig,
  input: SendGeneralAdminEmailInput,
): Promise<boolean> {
  return sendResendEmail(config, {
    to: config.adminToEmail,
    subject: input.subject,
    text: input.text,
    replyTo: input.replyTo,
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
};

export type InboundMessage = {
  preparedFullText: string;
  report: string;
  replyTo: string;
  adminSubject: string;
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

export async function triggerInvestigation(
  config: OrchestratorConfig,
  report: string,
): Promise<TriggerInvestigationResult> {
  if (config.devTestMode) {
    console.log("DEV_TEST_MODE: skipping investigation trigger", {
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

  try {
    const resp = await fetch(`${config.bugfixagentUrl}/investigations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiAccessKey}`,
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

  return {
    investigationRequestId,
    orchestratorStatus,
  };
}

export function contactFormInbound(
  email: string,
  message: string,
  adminSubject: string,
): InboundMessage {
  return {
    preparedFullText: message,
    report: `From: ${email}\n\n${message}`,
    replyTo: email,
    adminSubject,
  };
}

export function inboundEmail(
  sender: string,
  recipient: string,
  subject: string,
  bodyText: string,
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
  };
}

export async function routeInboundMessage(input: {
  message: InboundMessage;
  routeConfig: RouteConfig;
  onSpamBlocked?: () => Promise<void>;
}): Promise<RouteInboundResult> {
  const { message, routeConfig, onSpamBlocked } = input;

  if (shouldBlockAsSpam(message.preparedFullText)) {
    await onSpamBlocked?.();
    return { outcome: "spam" };
  }

  if (!shouldInvestigateReport(message.preparedFullText)) {
    const adminEmailSent = await sendGeneralAdminEmail(routeConfig.resend, {
      subject: message.adminSubject,
      text: message.report,
      replyTo: message.replyTo,
    });
    return { outcome: "general", adminEmailSent };
  }

  const investigation = await triggerInvestigation(
    routeConfig.orchestrator,
    message.report,
  );

  return { outcome: "investigation", investigation };
}
