// Spam gate config, bundled into the worker at BUILD time.
//
// Source of truth: ebram.config.yaml at the repo root. wrangler inlines it
// as text via the `rules` Text match in wrangler.toml, and we parse it here
// with js-yaml. Editing the config requires the normal commit → PR → CI →
// deploy flow; there is no runtime fetching or caching.
//
// If the file is missing or invalid at runtime the worker falls back to the
// built-in defaults so a broken config never hard-blocks the inbox (and
// unit tests fail at PR time before it can ship).

import { load as yamlLoad } from "js-yaml";
import {
  DEFAULT_SPAM_BLOCK_MIN_MATCHES,
  DEFAULT_SPAM_WORDS,
} from "./gate.js";

export type SpamGateConfig = {
  words: readonly string[];
  minMatches: number;
  enableDeepSpamGate: boolean;
};

const DEFAULT_SPAM_GATE_CONFIG: SpamGateConfig = {
  words: DEFAULT_SPAM_WORDS,
  minMatches: DEFAULT_SPAM_BLOCK_MIN_MATCHES,
  enableDeepSpamGate: false,
};

type ParsedEbramConfig = {
  spam?: {
    words?: unknown;
    minMatches?: unknown;
    enableDeepSpamGate?: unknown;
  };
};

// Resolve a SpamGateConfig from yaml text; returns null if the config is
// missing or invalid so callers can fall back to the built-in defaults.
// (The worker bundles ebram.config.yaml via src/bundled-config.ts.)
export function parseSpamConfig(yamlText: string): SpamGateConfig | null {
  let parsed: ParsedEbramConfig;
  try {
    parsed = yamlLoad(yamlText) as ParsedEbramConfig;
  } catch (err) {
    console.warn("spam config yaml parse failed — using defaults", { err });
    return null;
  }

  const spam = parsed?.spam;
  if (!spam || typeof spam !== "object") {
    console.warn("spam config missing 'spam' section — using defaults");
    return null;
  }

  const words = Array.isArray(spam.words)
    ? spam.words.filter(
        (w): w is string => typeof w === "string" && w.trim().length > 0,
      ).map((w) => w.trim())
    : null;
  if (!words || words.length === 0) {
    console.warn("spam config 'spam.words' missing or empty — using defaults");
    return null;
  }

  const minMatches = (() => {
    const v = spam.minMatches;
    if (typeof v === "number" && Number.isInteger(v) && v >= 1) return v;
    if (typeof v !== "undefined") {
      console.warn("spam config 'spam.minMatches' invalid — using default", { minMatches: v });
    }
    return DEFAULT_SPAM_BLOCK_MIN_MATCHES;
  })();

  // Deep filter runs ONLY when explicitly enabled in the config.
  // Missing/invalid flag ⇒ treated as disabled.
  const enableDeepSpamGate = spam.enableDeepSpamGate === true;
  if (typeof spam.enableDeepSpamGate !== "undefined" && typeof spam.enableDeepSpamGate !== "boolean") {
    console.warn("spam config 'spam.enableDeepSpamGate' invalid — deep filter disabled", {
      enableDeepSpamGate: spam.enableDeepSpamGate,
    });
  }

  return { words, minMatches, enableDeepSpamGate };
}

