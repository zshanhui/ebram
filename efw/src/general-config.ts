// Parser for the `general` section of ebram.config.yaml (repo root).
//
// Unit tests import this module directly (parser + validation); the worker
// loads the bundled yaml via bundled-config.ts, because only the wrangler
// bundler can import .yaml files.
//
// Runtime fallback philosophy matches spam-config.ts: a missing or invalid
// section returns null so callers can disable the general admin email
// (an empty inbox is logged and skipped, not sent to Resend).

import { load as yamlLoad } from "js-yaml";

export type GeneralConfig = {
  /** Admin inbox for non-investigation inbound mail (contact form + general email). */
  contactEmail: string;
};

type ParsedEbramConfig = {
  general?: {
    contact_email?: unknown;
  };
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Resolve a GeneralConfig from yaml text; returns null if the section is
// missing or invalid so callers can fall back to the env var.
export function parseGeneralConfig(yamlText: string): GeneralConfig | null {
  let parsed: ParsedEbramConfig;
  try {
    parsed = yamlLoad(yamlText) as ParsedEbramConfig;
  } catch (err) {
    console.warn("general config yaml parse failed — using fallback", { err });
    return null;
  }

  const general = parsed?.general;
  if (!general || typeof general !== "object") {
    return null;
  }

  const contactEmail = general.contact_email;
  if (typeof contactEmail !== "string" || !EMAIL_RE.test(contactEmail.trim())) {
    console.warn("general config 'general.contact_email' missing or invalid — general admin email disabled", {
      contact_email: contactEmail,
    });
    return null;
  }

  return { contactEmail: contactEmail.trim() };
}
