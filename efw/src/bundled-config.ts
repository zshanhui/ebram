// Worker-only module: imports the bundled ebram.config.yaml (inlined as
// text by the wrangler `rules` config) and resolves the runtime spam gate
// config from it. Unit tests import spam-config.ts directly (parser +
// factory) and never load this module, because node/tsx cannot import
// .yaml files — only the wrangler bundler can.

import configYaml from "../../ebram.config.yaml";
import { parseSpamConfig, type SpamGateConfig } from "./spam-config.js";
import {
  DEFAULT_SPAM_BLOCK_MIN_MATCHES,
  DEFAULT_SPAM_WORDS,
} from "./gate.js";

export const SPAM_GATE_CONFIG: SpamGateConfig = parseSpamConfig(configYaml) ?? {
  words: DEFAULT_SPAM_WORDS,
  minMatches: DEFAULT_SPAM_BLOCK_MIN_MATCHES,
  enableDeepSpamGate: false,
};
