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
  DEV_TEST_MODE?: string;
};

export function isDevTestMode(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "1":
    case "on":
    case "true":
      return true;
    case "0":
    case "off":
    case "false":
      return false;
    default:
      return false;
  }
}

export type WorkerRouteConfig = RouteConfig;

export function contactFormAdminSubject(env: Pick<WorkerRouteEnv, "CONTACT_FORM_ADMIN_SUBJECT">): string {
  const subject = env.CONTACT_FORM_ADMIN_SUBJECT?.trim();
  return subject || DEFAULT_CONTACT_FORM_ADMIN_SUBJECT;
}

export function workerRouteConfigFromEnv(env: WorkerRouteEnv): WorkerRouteConfig {
  return {
    resend: resendConfigFromEnv(env),
    orchestrator: orchestratorConfigFromEnv(env, isDevTestMode(env.DEV_TEST_MODE)),
  };
}

export type { OrchestratorConfig };
