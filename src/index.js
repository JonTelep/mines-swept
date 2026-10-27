// Static files are served by Workers assets. This script handles the live
// field (socket, public stats, share card) and the newsletter routes.

import { Board } from "./board.js";
import { handleSubscribe } from "./newsletter/subscribe.js";
import { handleUnsubscribe } from "./newsletter/unsubscribe.js";

export { Board };

const jsonError = (status) =>
  new Response(JSON.stringify({ ok: false, error: "Could not subscribe right now. Please try again later." }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/api/subscribe") return await handleSubscribe(request, env);
      if (path === "/api/unsubscribe") return await handleUnsubscribe(request, env);
    } catch {
      return jsonError(500);
    }
    if (path === "/ws" || path === "/og.png" || path.startsWith("/api/")) {
      const id = env.BOARD.idFromName("world");
      return env.BOARD.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
