import {
  orchestratorConfigFromEnv,
  resendConfigFromEnv,
  type OrchestratorConfig,
  type RouteConfig,
} from "./routing-helpers.js";
import { GENERAL_CONFIG } from "./bundled-config.js";

const DEFAULT_CONTACT_FORM_ADMIN_SUBJECT = "LevelChinese News contact form";

export type WorkerRouteEnv = {
  BUGFIXAGENT_URL: string;
  EBRAM_API_ACCESS_KEY: string;
  RESEND_API_KEY: string;
  MAIL_FROM: string;
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
  // Admin inbox for general (non-investigation) inbound mail: sourced from
  // general.contact_email in the bundled ebram.config.yaml. An empty value
  // means general admin mail is disabled (sendGeneralAdminEmail logs and
  // skips instead of calling Resend).
  return {
    resend: { ...resendConfigFromEnv(env), adminToEmail: GENERAL_CONFIG.contactEmail },
    orchestrator: orchestratorConfigFromEnv(env, isDevTestMode(env.DEV_TEST_MODE)),
  };
}

export type { OrchestratorConfig };
