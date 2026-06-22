import {
  orchestratorConfigFromEnv,
  resendConfigFromEnv,
  type OrchestratorConfig,
  type RouteConfig,
} from "./routing-helpers.js";

const DEFAULT_CONTACT_FORM_ADMIN_SUBJECT = "LevelChinese News contact form";

export type WorkerRouteEnv = {
  BUGFIXAGENT_URL: string;
  EBRAM_API_ACCESS_KEY: string;
  RESEND_API_KEY: string;
  MAIL_FROM: string;
  CONTACT_TO_EMAIL: string;
  CONTACT_FORM_ADMIN_SUBJECT?: string;
};

export type WorkerRouteConfig = RouteConfig;

export function contactFormAdminSubject(env: Pick<WorkerRouteEnv, "CONTACT_FORM_ADMIN_SUBJECT">): string {
  const subject = env.CONTACT_FORM_ADMIN_SUBJECT?.trim();
  return subject || DEFAULT_CONTACT_FORM_ADMIN_SUBJECT;
}

export function workerRouteConfigFromEnv(env: WorkerRouteEnv): WorkerRouteConfig {
  return {
    resend: resendConfigFromEnv(env),
    orchestrator: orchestratorConfigFromEnv(env),
  };
}

export type { OrchestratorConfig };
