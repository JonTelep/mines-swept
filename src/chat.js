// Chat shaping. Rendering is the client's job; this only accepts or rejects text.

import { containsSlur } from "./slurs.js";

export const CHAT_MAX = 200;
export const CHAT_MS = 2000;
export const CHAT_KEEP = 100;

export function checkChatRate(lastAt, now) {
  if (!lastAt) return true;
  return now - lastAt >= CHAT_MS;
}

export function prepareChat(text) {
  if (typeof text !== "string") return { error: "chat" };
  let body = text.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!body) return { error: "chat" };
  if (body.length > CHAT_MAX) body = body.slice(0, CHAT_MAX);
  body = body.replace(/[<>]/g, "");
  if (!body) return { error: "chat" };
  if (containsSlur(body)) return { error: "blocked" };
  return { body };
}
