// Fixed-window counter. Each Worker isolate keeps its own map, so a burst
// can land on more than one isolate. A full window still rejects.

const hits = new Map();

export function resetLimits() {
  hits.clear();
}

export function allow(key, limit, windowMs, now = Date.now()) {
  const prev = hits.get(key);
  const fresh = prev && now - prev.start < windowMs ? prev : { start: now, n: 0 };
  fresh.n += 1;
  hits.set(key, fresh);
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (now - v.start >= windowMs) hits.delete(k);
    }
  }
  return fresh.n <= limit;
}

export function clientIp(request) {
  const raw = request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || "";
  return raw.split(",")[0].trim() || "unknown";
}
