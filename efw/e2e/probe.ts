// Test-only worker: exposes the DeepSpamFilter over HTTP so the e2e suite can
// exercise the REAL Workers AI binding through `wrangler dev` (local mode
// proxies AI calls to the real remote service, so this is a true e2e).
//
// Not deployed anywhere — used only by `e2e/deep-spam.e2e.test.ts`.

import { DeepSpamFilter } from "../src/gate.js";

interface ProbeEnv {
  AI?: Ai;
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ready") {
      return new Response("ok");
    }

    if (url.pathname === "/classify") {
      const text = url.searchParams.get("text") ?? "";
      if (!env.AI) {
        return new Response(JSON.stringify({ error: "missing AI binding" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      const filter = new DeepSpamFilter(env.AI);
      const isSpam = await filter.detectSpam(text, "e2e-probe");
      return new Response(JSON.stringify({ isSpam }), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<ProbeEnv>;
