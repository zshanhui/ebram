// Naive contact-form gate: the page must post from an allowed origin and,
// when enable_form_token is true, a hidden token derived from the worker URL
// and MAIL_FROM. A script that only hits the worker URL fails. This is not a
// bot challenge.

import { load as yamlLoad } from "js-yaml";

export function originsFromRedirects(redirects: readonly string[]): string[] {
  const origins: string[] = [];
  for (const raw of redirects) {
    try {
      const origin = new URL(raw).origin;
      if (!origins.includes(origin)) origins.push(origin);
    } catch {
      // Skip a redirect that is not an absolute URL.
    }
  }
  return origins;
}

export function callerOrigin(originHeader: string | null, refererHeader: string | null): string | null {
  const origin = originHeader?.trim();
  if (origin) return origin;
  const referer = refererHeader?.trim();
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

export function isAllowedContactCaller(
  originHeader: string | null,
  refererHeader: string | null,
  allowedOrigins: readonly string[],
): boolean {
  const caller = callerOrigin(originHeader, refererHeader);
  if (!caller) return false;
  return allowedOrigins.includes(caller);
}

// sha256(`${workerOrigin}\n${mailFrom}`) — the Astro form uses the same
// material (PUBLIC_CONTACT_WORKER_URL origin + site contact email, which
// must match MAIL_FROM).
export async function contactFormToken(workerUrl: string, mailFrom: string): Promise<string> {
  const origin = new URL(workerUrl).origin;
  const material = `${origin}\n${mailFrom.trim().toLowerCase()}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Missing or non-boolean enable_form_token counts as false.
export function parseEnableFormToken(yamlText: string): boolean {
  let parsed: { enable_form_token?: unknown };
  try {
    parsed = yamlLoad(yamlText) as { enable_form_token?: unknown };
  } catch (err) {
    console.warn("form token config yaml parse failed — token check disabled", { err });
    return false;
  }

  const flag = parsed?.enable_form_token;
  if (flag === true) return true;
  if (typeof flag !== "undefined" && typeof flag !== "boolean") {
    console.warn("ebram config 'enable_form_token' invalid — token check disabled", {
      enable_form_token: flag,
    });
  }
  return false;
}

export function contactTokenMatches(submitted: string, expected: string): boolean {
  const want = expected.trim();
  if (!want) return false;
  return submitted.trim() === want;
}
