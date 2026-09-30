// Static files are served by Workers assets. This script only handles the
// live field: the socket, the public stats, and the share card.

import { Board } from "./board.js";

export { Board };

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/ws" || path === "/og.png" || path.startsWith("/api/")) {
      const id = env.BOARD.idFromName("world");
      return env.BOARD.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
