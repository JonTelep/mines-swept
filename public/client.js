const canvas = document.getElementById("field");
const ctx = canvas.getContext("2d");
const $ = (id) => document.getElementById(id);

const NUM = {
  1: "#2c6ecb",
  2: "#3e7d49",
  3: "#c4473a",
  4: "#4a3494",
  5: "#8a3a2a",
  6: "#2a7574",
  7: "#2a2118",
  8: "#6d5b49",
};

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const MONO = "ui-monospace, Menlo, Consolas, monospace";
const cells = new Map();
const cursors = new Map();
const flashes = new Map();
let particles = [];

const cam = { x: 500, y: 500, z: 36 };
const goal = { x: 500, y: 500, z: 36 };
let boardSize = 1000;
const BIN = 8;
const mapCanvas = document.createElement("canvas");
const mapCtx = mapCanvas.getContext("2d", { willReadFrequently: true });
let mapN = 0;
let mapRev = new Uint8Array(0);
let mapFlag = new Uint8Array(0);
let mapBlast = new Uint8Array(0);
let mapDirty = true;
const pins = new Map();
let cssW = 1;
let cssH = 1;
let dpr = 1;
let hover = null;
let flagMode = false;
let me = { id: "", name: "…", color: "#e4b15a", score: 0, clears: 0, booms: 0, cooldownUntil: 0 };
let roundState = { n: 1, startedAt: 0, phase: "play", online: 0, nextAt: 0 };
let roundTicked = false;
let audioOn = localStorage.getItem("minesswept.sound") === "1";
let actx = null;
let ws = null;
let alive = false;
let retry = 400;
let lastView = "";
let viewTimer = 0;
let toastTimer = 0;
let hinted = false;

const pointers = new Map();
let pinch = null;
let press = null;

function playerId() {
  let id = localStorage.getItem("minesswept.id");
  if (!id || !/^[A-Za-z0-9_-]{8,40}$/.test(id)) {
    id = crypto.randomUUID();
    localStorage.setItem("minesswept.id", id);
  }
  return id;
}

function resize() {
  dpr = Math.min(2, devicePixelRatio || 1);
  cssW = innerWidth;
  cssH = innerHeight;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const mini = $("mini");
  if (mini) {
    const css = cssW <= 800 ? 76 : 104;
    const scale = Math.min(2, dpr);
    mini.width = Math.floor(css * scale);
    mini.height = Math.floor(css * scale);
  }
  const across = cssW < 700 ? 11 : 18;
  if (!resize.did) {
    cam.z = clamp(Math.floor(cssW / across), minZoom(), 48);
    goal.z = cam.z;
    goal.x = cam.x;
    goal.y = cam.y;
    resize.did = true;
  }
  scheduleView();
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function fitZoom() {
  const pad = 36;
  return Math.max(0.05, Math.min((cssW - pad) / boardSize, (cssH - pad) / boardSize));
}

function minZoom() {
  return fitZoom();
}

function usesOverview() {
  return Math.max(cssW, cssH) / cam.z > 72;
}

function inBoard(x, y) {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < boardSize && y < boardSize;
}

function useSize(n) {
  const size = n | 0;
  if (size < 8 || size === boardSize) return;
  boardSize = size;
  cam.x = goal.x = size / 2;
  cam.y = goal.y = size / 2;
  const z = clamp(32, minZoom(), 48);
  cam.z = goal.z = z;
  mapN = 0;
  lastView = "";
  scheduleView();
}

function clampCamera(c) {
  const halfW = cssW / 2 / c.z;
  const halfH = cssH / 2 / c.z;
  if (halfW * 2 >= boardSize) c.x = boardSize / 2;
  else c.x = clamp(c.x, halfW, boardSize - halfW);
  if (halfH * 2 >= boardSize) c.y = boardSize / 2;
  else c.y = clamp(c.y, halfH, boardSize - halfH);
}

function fitBoard() {
  goal.x = boardSize / 2;
  goal.y = boardSize / 2;
  goal.z = fitZoom();
  clampCamera(goal);
}

function ensureMap() {
  const n = Math.max(1, Math.ceil(boardSize / BIN));
  if (mapN === n && mapRev.length === n * n) return;
  mapN = n;
  mapRev = new Uint8Array(n * n);
  mapFlag = new Uint8Array(n * n);
  mapBlast = new Uint8Array(n * n);
  mapCanvas.width = n;
  mapCanvas.height = n;
  mapDirty = true;
}

function decodeBins(b64) {
  if (!b64) return [];
  const raw = atob(b64);
  const out = [];
  for (let i = 0; i + 4 < raw.length; i += 5) {
    out.push({
      bx: raw.charCodeAt(i),
      by: raw.charCodeAt(i + 1),
      revealed: raw.charCodeAt(i + 2),
      flags: raw.charCodeAt(i + 3),
      blast: raw.charCodeAt(i + 4),
    });
  }
  return out;
}

function applyMap(msg, reset) {
  if (!msg) return;
  ensureMap();
  if (reset) {
    mapRev.fill(0);
    mapFlag.fill(0);
    mapBlast.fill(0);
  }
  for (const bin of decodeBins(msg.bins)) {
    if (bin.bx < 0 || bin.by < 0 || bin.bx >= mapN || bin.by >= mapN) continue;
    const i = bin.by * mapN + bin.bx;
    mapRev[i] = bin.revealed;
    mapFlag[i] = bin.flags;
    mapBlast[i] = bin.blast;
  }
  mapDirty = true;
}

function paintMapImage() {
  ensureMap();
  if (!mapDirty) return;
  const img = mapCtx.createImageData(mapN, mapN);
  const d = img.data;
  for (let i = 0; i < mapN * mapN; i++) {
    const o = i * 4;
    const rev = mapRev[i];
    const flag = mapFlag[i];
    const blast = mapBlast[i];
    if (blast) {
      d[o] = 212;
      d[o + 1] = 72;
      d[o + 2] = 48;
      d[o + 3] = 255;
      continue;
    }
    const t = Math.min(1, rev / 28);
    let r = 46 + t * (214 - 46);
    let g = 38 + t * (190 - 38);
    let b = 28 + t * (142 - 28);
    if (flag) {
      const f = Math.min(1, flag / 6);
      r = r * (1 - f) + 228 * f;
      g = g * (1 - f) + 177 * f;
      b = b * (1 - f) + 90 * f;
    }
    d[o] = r;
    d[o + 1] = g;
    d[o + 2] = b;
    d[o + 3] = 255;
  }
  mapCtx.putImageData(img, 0, 0);
  mapDirty = false;
}

function worldToScreen(wx, wy) {
  return [cssW / 2 + (wx - cam.x) * cam.z, cssH / 2 + (wy - cam.y) * cam.z];
}

function screenToWorld(px, py) {
  return [cam.x + (px - cssW / 2) / cam.z, cam.y + (py - cssH / 2) / cam.z];
}

function cellAt(px, py) {
  const [wx, wy] = screenToWorld(px, py);
  return [Math.floor(wx), Math.floor(wy)];
}

function grit(x, y) {
  let h = Math.imul((x ^ 0x5bd1e995) | 0, 0x45d9f3b) ^ Math.imul((y ^ 0x27d4eb2d) | 0, 0x85ebca6b);
  h ^= h >>> 16;
  return (h >>> 0) % 20;
}

function viewRect() {
  const hw = cssW / 2 / cam.z + 2;
  const hh = cssH / 2 / cam.z + 2;
  let x0 = Math.floor(cam.x - hw);
  let y0 = Math.floor(cam.y - hh);
  let x1 = Math.ceil(cam.x + hw);
  let y1 = Math.ceil(cam.y + hh);
  if (x1 - x0 > 78) {
    const mid = Math.round((x0 + x1) / 2);
    x0 = mid - 39;
    x1 = x0 + 78;
  }
  if (y1 - y0 > 78) {
    const mid = Math.round((y0 + y1) / 2);
    y0 = mid - 39;
    y1 = y0 + 78;
  }
  return { x0, y0, x1, y1 };
}

function scheduleView() {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(sendView, 90);
}

function sendView() {
  if (!alive) return;
  if (usesOverview()) {
    if (lastView === "wide") return;
    lastView = "wide";
    send({ t: "view", wide: 1 });
    return;
  }
  const v = viewRect();
  const sig = `${v.x0},${v.y0},${v.x1},${v.y1}`;
  if (sig === lastView) return;
  lastView = sig;
  send({ t: "view", ...v });
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    alive = true;
    retry = 400;
    lastView = "";
    const v = viewRect();
    send({
      t: "hello",
      id: playerId(),
      name: localStorage.getItem("minesswept.name") || "",
      v,
    });
    lastView = `${v.x0},${v.y0},${v.x1},${v.y1}`;
    $("pip").className = "pip live";
  };
  ws.onmessage = (ev) => {
    if (ev.data === "pong" || ev.data === "ping") return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    onMsg(msg);
  };
  ws.onclose = () => {
    alive = false;
    $("pip").className = "pip down";
    $("online").textContent = "reconnecting";
    setTimeout(connect, retry);
    retry = Math.min(8000, retry * 1.6);
  };
  ws.onerror = () => {};
}

setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send("ping");
}, 10000);

function onMsg(msg) {
  if (msg.t === "welcome") {
    me = { ...me, ...msg.you };
    localStorage.setItem("minesswept.name", me.name);
    paintHud(msg.stats);
    paintLeaders(msg.leaderboard || []);
    paintWho(msg.players || []);
    paintFeed(msg.feed?.[0]);
    applySnapshot(msg);
    takeStats(msg.stats);
    paintHistory(msg.history, msg.stats?.best, msg.fame);
    if (msg.stats?.size) useSize(msg.stats.size);
    if (msg.map) applyMap(msg.map, true);
    if (msg.chat) for (const line of msg.chat) addChat(line);
    if (msg.over?.win) showWin(msg.over);
    else if (msg.over) showOver(msg.over);
    return;
  }
  if (msg.t === "snapshot") {
    if (msg.map) applyMap(msg.map, Boolean(msg.map.reset) || msg.wide);
    if (msg.wide) return;
    applySnapshot(msg);
    if (msg.cursors) for (const p of msg.cursors) noteCursor(p);
    return;
  }
  if (msg.t === "map") {
    applyMap(msg, Boolean(msg.reset));
    return;
  }
  if (msg.t === "pin" && msg.p) {
    notePin(msg.p);
    return;
  }
  if (msg.t === "win") {
    showWin(msg);
    return;
  }
  if (msg.t === "delta") {
    applyCells(msg.cells || [], true);
    if (msg.event) paintFeed(msg.event);
    if (msg.stats) takeStats(msg.stats);
    if (msg.leaderboard) paintLeaders(msg.leaderboard);
    if (msg.event?.type === "clear" && msg.event.n > 12) chime();
    return;
  }
  if (msg.t === "you") {
    const wasCool = me.cooldownUntil;
    me = { ...me, ...msg };
    localStorage.setItem("minesswept.name", me.name);
    paintYou();
    if (msg.spared === "grace") toast("The field is still settling.");
    if (msg.spared === "shield") toast("You blew the last round. This one isn't yours to end.");
    if (msg.cooldownUntil > Date.now() && msg.cooldownUntil !== wasCool) {
      $("live").textContent = "Short cooldown.";
    }
    return;
  }
  if (msg.t === "presence") {
    if (msg.stats) takeStats(msg.stats);
    paintWho(msg.players || []);
    return;
  }
  if (msg.t === "over") {
    showOver(msg);
    return;
  }
  if (msg.t === "round") {
    showRound(msg);
    return;
  }
  if (msg.t === "chat" && msg.msg) {
    addChat(msg.msg);
    return;
  }
  if (msg.t === "cursors") {
    for (const p of msg.p || []) noteCursor(p);
    return;
  }
  if (msg.t === "no") {
    const lines = {
      cooldown: "You're in the crater. Give it a second.",
      rate: "Easy — the field can only take so much at once.",
      bounds: "That's off the map.",
      flagged: "Unflag it first.",
      chord: "Those flags don't add up.",
      revealed: "Already open.",
      name: "Pick another name.",
      packed: "Too many sweepers. Try again in a minute.",
      server: "The field hiccuped. Try that again.",
      over: "This round is already over.",
      blocked: "Message not sent",
      chat: "Slow down a little.",
    };
    toast(lines[msg.reason] || "Couldn't do that.");
  }
}

function applySnapshot(msg) {
  if (msg.x0 == null && msg.cells) {
    cells.clear();
    applyCells(msg.cells, false);
    if (msg.cursors) for (const p of msg.cursors) noteCursor(p);
    return;
  }
  for (const [k, c] of cells) {
    if (c.x >= msg.x0 && c.x <= msg.x1 && c.y >= msg.y0 && c.y <= msg.y1) cells.delete(k);
  }
  applyCells(msg.cells || [], false);
  if (msg.cursors) {
    for (const p of msg.cursors) noteCursor(p);
  }
}

function applyCells(list, flash) {
  const now = performance.now();
  for (const c of list) {
    const k = c.x + "," + c.y;
    if (c.k === "h") {
      cells.delete(k);
      continue;
    }
    cells.set(k, c);
    if (flash && c.f) flashes.set(k, now + 700);
    if (flash && c.k === "m") burst(c.x, c.y, c.c);
  }
}

function noteCursor(p) {
  if (!p || p.id === me.id) return;
  cursors.set(p.id, { ...p, at: performance.now() });
  notePin(p);
}

function notePin(p) {
  if (!p || p.id === me.id || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
  pins.set(p.id, { ...p, at: performance.now() });
}

function paintYou() {
  $("name").textContent = me.name;
  $("score").textContent = fmt(me.score);
  const blew = me.booms === 1 ? "blew 1 round" : `blew ${fmt(me.booms)} rounds`;
  $("personal").textContent = `${fmt(me.clears)} dug · ${blew}`;
}

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

function takeStats(stats) {
  paintHud(stats);
  if (!stats) return;
  if (stats.round) roundState.n = stats.round;
  if (stats.startedAt) roundState.startedAt = stats.startedAt;
  if (stats.phase) roundState.phase = stats.phase;
  roundState.online = stats.online | 0;
  roundState.nextAt = stats.nextAt || roundState.nextAt;
  paintRound();
}

function paintRound() {
  const el = $("survived");
  if (!el) return;
  if (roundState.phase === "over") {
    const left = Math.max(0, Math.ceil((roundState.nextAt - Date.now()) / 1000));
    const next = $("over-next");
    if (next) next.textContent = left > 0 ? `Next round in ${left}s` : "New ground…";
    el.textContent = `Round #${roundState.n} is over`;
    if (left === 0 && !roundTicked) {
      roundTicked = true;
      send({ t: "tick" });
    }
    return;
  }
  const elapsed = roundState.startedAt ? Date.now() - roundState.startedAt : 0;
  const people = roundState.online === 1 ? "1 would lose" : `${fmt(roundState.online)} would lose`;
  el.textContent = `Round #${roundState.n} survived ${clock(elapsed)} · ${people}`;
}

function paintHud(stats) {
  paintYou();
  if (!stats) return;
  const dug = stats.roundCleared != null ? stats.roundCleared : stats.cleared;
  $("everyone").innerHTML = `<strong>${fmt(dug)}</strong> dug this round`;
  if (alive) $("online").textContent = `${stats.online} sweeping`;
  if (stats.size) useSize(stats.size);
  if (stats.safe != null) progress.safe = stats.safe | 0;
  if (stats.roundCleared != null) progress.cleared = stats.roundCleared | 0;
  paintProgress();
  if (stats.best) paintHistory(null, stats.best);
}

function paintHistory(rows, best, fame) {
  if (best && $("best")) {
    $("best").textContent = best.ms
      ? `Longest round #${best.round} survived ${clock(best.ms)}`
      : "No round has ended yet.";
  }
  if (rows) paintHall("shame", rows);
  if (fame) paintHall("fame", fame);
}

function paintHall(id, rows) {
  const ol = $(id);
  if (!ol) return;
  ol.replaceChildren();
  for (const row of rows) {
    const li = document.createElement("li");
    const who = document.createElement("span");
    who.style.color = row.color || "#e4b15a";
    who.textContent = row.name;
    const meta = document.createElement("span");
    meta.textContent = `#${row.n} · ${clock(row.durationMs)} · ${fmt(row.cleared)}`;
    li.append(who, meta);
    ol.appendChild(li);
  }
  if (id === "fame") {
    const empty = $("fame-empty");
    if (empty) empty.hidden = rows.length > 0;
  }
}

let progress = { cleared: 0, safe: 0 };

function paintProgress() {
  const bar = $("progress");
  const track = $("progress-track");
  const label = $("progress-label");
  if (!bar || !track) return;
  const safe = progress.safe | 0;
  const cleared = Math.max(0, progress.cleared | 0);
  const pct = safe > 0 ? Math.min(100, (cleared / safe) * 100) : 0;
  bar.style.width = `${pct}%`;
  track.setAttribute("aria-valuenow", String(Math.round(pct)));
  if (!label) return;
  if (!safe) {
    label.textContent = "0% clear";
    return;
  }
  const shown = pct <= 0 ? "0" : pct >= 10 ? pct.toFixed(1) : pct >= 0.1 ? pct.toFixed(2) : pct.toFixed(3);
  label.textContent = `${shown}% clear · ${fmt(cleared)} / ${fmt(safe)}`;
}

function showOver(msg) {
  roundState.phase = "over";
  roundState.n = msg.round || roundState.n;
  roundState.nextAt = msg.nextAt || roundState.nextAt;
  roundState.online = msg.online | 0;
  roundTicked = false;
  const banner = $("over");
  banner.hidden = false;
  banner.classList.remove("win");
  $("over-kicker").textContent = "Game over";
  $("over-name").textContent = msg.name || "Someone";
  $("over-name").style.color = msg.color || "#d4533a";
  $("over-line").textContent = msg.line || "";
  $("over-tops").replaceChildren();
  if (msg.cells) applyCells(msg.cells, true);
  if (Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
    const z = clamp(Math.max(cam.z, 32), minZoom(), 48);
    cam.x = goal.x = msg.x + 0.5;
    cam.y = goal.y = msg.y + 0.5;
    cam.z = goal.z = z;
    clampCamera(cam);
    goal.x = cam.x;
    goal.y = cam.y;
    lastView = "";
    scheduleView();
  }
  paintHistory(msg.history, msg.best, msg.fame);
  if (msg.stats) takeStats(msg.stats);
  punch();
  boom(true);
  paintRound();
}

function showWin(msg) {
  roundState.phase = "over";
  roundState.n = msg.round || roundState.n;
  roundState.nextAt = msg.nextAt || roundState.nextAt;
  roundState.online = msg.online | 0;
  roundTicked = false;
  const banner = $("over");
  banner.hidden = false;
  banner.classList.add("win");
  $("over-kicker").textContent = "Cleared";
  $("over-name").textContent = msg.name || "Everyone";
  $("over-name").style.color = msg.color || "#8eae78";
  $("over-line").textContent = msg.line || "";
  paintTops(msg.tops || []);
  paintHistory(msg.history, msg.best, msg.fame);
  if (msg.stats) takeStats(msg.stats);
  fitBoard();
  if (!reduceMotion) {
    document.body.classList.add("winflash");
    setTimeout(() => document.body.classList.remove("winflash"), 700);
  }
  fanfare();
  paintRound();
}

function paintTops(rows) {
  const ol = $("over-tops");
  if (!ol) return;
  ol.replaceChildren();
  for (const row of rows.slice(0, 5)) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.style.color = row.color || "#e4b15a";
    name.textContent = row.name;
    const meta = document.createElement("span");
    meta.textContent = `${fmt(row.clears)} dug`;
    li.append(name, meta);
    ol.appendChild(li);
  }
}

function showRound(msg) {
  roundState = {
    n: msg.round || roundState.n + 1,
    startedAt: msg.startedAt || Date.now(),
    phase: "play",
    online: msg.stats?.online | 0,
    nextAt: 0,
  };
  roundTicked = false;
  cells.clear();
  flashes.clear();
  pins.clear();
  const banner = $("over");
  banner.hidden = true;
  banner.classList.remove("win");
  $("over-tops").replaceChildren();
  me.score = 0;
  me.clears = 0;
  progress.cleared = 0;
  paintYou();
  paintProgress();
  if (msg.map) applyMap(msg.map, true);
  if (msg.stats) takeStats(msg.stats);
  if (msg.leaderboard) paintLeaders(msg.leaderboard);
  paintHistory(msg.history, msg.best || msg.stats?.best, msg.fame);
  paintRound();
}

function addChat(m) {
  if (!m || m.body == null) return;
  const log = $("chat-log");
  if ([...log.children].some((li) => li.dataset.id === String(m.id))) return;
  const li = document.createElement("li");
  if (m.id != null) li.dataset.id = String(m.id);
  if (m.kind === "system") li.className = "system";
  const who = document.createElement("span");
  who.className = "who-name";
  who.style.color = m.color || "#e4b15a";
  who.textContent = m.kind === "system" ? "Field" : (m.name || "Someone");
  const body = document.createElement("span");
  body.textContent = m.body;
  li.append(who, body);
  log.append(li);
  while (log.children.length > 100) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

function paintLeaders(rows) {
  const ol = $("leaders");
  ol.replaceChildren();
  if (!rows.length) {
    const li = document.createElement("li");
    li.textContent = "No scores yet. Dig.";
    ol.appendChild(li);
    return;
  }
  rows.forEach((row, i) => {
    const li = document.createElement("li");
    if (row.id === me.id) li.className = "me";
    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = String(i + 1);
    const name = document.createElement("span");
    const dot = document.createElement("i");
    dot.className = "dot";
    dot.style.background = row.color;
    name.append(dot, document.createTextNode(row.name));
    const pts = document.createElement("span");
    pts.className = "pts";
    pts.textContent = fmt(row.score);
    li.append(rank, name, pts);
    ol.appendChild(li);
  });
}

function paintWho(players) {
  const box = $("who");
  box.replaceChildren();
  for (const p of players.slice(0, 12)) {
    const chip = document.createElement("span");
    chip.style.color = p.color;
    chip.textContent = p.name;
    box.appendChild(chip);
  }
}

function paintFeed(event) {
  if (!event) return;
  let line = `${event.name} dug a cell`;
  if (event.type === "boom") line = `${event.name} hit a mine`;
  else if (event.n > 1) line = `${event.name} dug ${fmt(event.n)}`;
  $("ticker").textContent = line;
  $("live").textContent = line;
}

function fmt(n) {
  return Math.max(0, n | 0).toLocaleString("en-US");
}

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

function punch() {
  if (reduceMotion) return;
  document.body.classList.add("boom");
  setTimeout(() => document.body.classList.remove("boom"), 280);
}

function cellInView(x, y) {
  if (x == null || y == null) return false;
  const v = viewRect();
  return x >= v.x0 - 1 && x <= v.x1 + 1 && y >= v.y0 - 1 && y <= v.y1 + 1;
}

function primeAudio() {
  if (!audioOn) return;
  try {
    if (!actx) actx = new AudioContext();
    if (actx.state !== "running") actx.resume();
  } catch {
    /* no audio device */
  }
}

function play(fn) {
  if (!audioOn) return;
  try {
    if (!actx) actx = new AudioContext();
    const run = () => {
      if (!actx || actx.state !== "running") return;
      try { fn(actx); } catch { /* a node failed to start */ }
    };
    if (actx.state === "running") run();
    else actx.resume().then(run).catch(() => {});
  } catch {
    /* autoplay or missing audio */
  }
}

function tone(ctx, { type, freq, end, dur, vol, at }) {
  const t = ctx.currentTime + (at || 0);
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (end) o.frequency.exponentialRampToValueAtTime(end, t + dur);
  g.gain.setValueAtTime(Math.max(vol, 0.0001), t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g);
  g.connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function crack(ctx, dur, vol) {
  const t = ctx.currentTime;
  const length = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const env = 1 - i / length;
    data[i] = (Math.random() * 2 - 1) * env * env;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(900, t);
  const g = ctx.createGain();
  g.gain.setValueAtTime(Math.max(vol, 0.0001), t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(filter);
  filter.connect(g);
  g.connect(ctx.destination);
  src.start(t);
}

function digSound() {
  play((ctx) => tone(ctx, { type: "triangle", freq: 740, end: 460, dur: 0.09, vol: 0.18 }));
}

function flagSound() {
  play((ctx) => tone(ctx, { type: "square", freq: 420, end: 280, dur: 0.07, vol: 0.1 }));
}

function chime() {
  play((ctx) => {
    tone(ctx, { type: "sine", freq: 520, end: 780, dur: 0.12, vol: 0.12 });
  });
}

function fanfare() {
  play((audio) => {
    tone(audio, { type: "sine", freq: 392, dur: 0.16, vol: 0.14, at: 0 });
    tone(audio, { type: "sine", freq: 523, dur: 0.18, vol: 0.15, at: 0.14 });
    tone(audio, { type: "sine", freq: 659, dur: 0.32, vol: 0.16, at: 0.3 });
    tone(audio, { type: "triangle", freq: 784, dur: 0.42, vol: 0.08, at: 0.3 });
  });
}

function boom(own) {
  play((ctx) => {
    const body = own ? 0.55 : 0.28;
    tone(ctx, { type: "sine", freq: own ? 160 : 120, end: 38, dur: own ? 0.55 : 0.4, vol: body });
    tone(ctx, { type: "square", freq: 70, dur: 0.08, vol: own ? 0.14 : 0.07 });
    crack(ctx, own ? 0.28 : 0.18, own ? 0.42 : 0.2);
  });
}

function burst(x, y, color) {
  if (reduceMotion) return;
  const [sx, sy] = worldToScreen(x + 0.5, y + 0.5);
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI * 2 * i) / 10;
    particles.push({
      x: sx,
      y: sy,
      vx: Math.cos(a) * (1.2 + Math.random()),
      vy: Math.sin(a) * (1.2 + Math.random()),
      life: 1,
      color: color || "#e4b15a",
    });
  }
}

function dig(x, y) {
  dismissHint();
  if (!inBoard(x, y)) {
    toast("That's off the map.");
    return;
  }
  if (flagMode) {
    send({ t: "flag", x, y });
    flagSound();
    return;
  }
  send({ t: "reveal", x, y });
  digSound();
}

function flag(x, y) {
  dismissHint();
  if (!inBoard(x, y)) {
    toast("That's off the map.");
    return;
  }
  send({ t: "flag", x, y });
  flagSound();
}

function dismissHint() {
  if (hinted) return;
  hinted = true;
  $("hint").classList.add("gone");
}

function easeCam() {
  const dx = goal.x - cam.x;
  const dy = goal.y - cam.y;
  const dz = goal.z - cam.z;
  if (Math.abs(dx) < 0.02 && Math.abs(dy) < 0.02 && Math.abs(dz) < 0.02) {
    if (easeCam.live) {
      cam.x = goal.x;
      cam.y = goal.y;
      cam.z = goal.z;
      easeCam.live = false;
      scheduleView();
    }
    return;
  }
  const wasFar = usesOverview();
  cam.x += dx * 0.28;
  cam.y += dy * 0.28;
  cam.z += dz * 0.28;
  easeCam.live = true;
  if (usesOverview() !== wasFar) {
    lastView = "";
    scheduleView();
  }
}

function drawBoardEdge() {
  const [sx, sy] = worldToScreen(0, 0);
  const span = boardSize * cam.z;
  ctx.strokeStyle = "rgba(228, 177, 90, 0.92)";
  ctx.lineWidth = usesOverview() ? 2 : 3;
  ctx.strokeRect(sx + 0.5, sy + 0.5, Math.max(1, span - 1), Math.max(1, span - 1));
}

function drawOverview() {
  paintMapImage();
  const [sx, sy] = worldToScreen(0, 0);
  const span = boardSize * cam.z;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(mapCanvas, sx, sy, span, span);
  drawBoardEdge();
  const now = performance.now();
  for (const [id, pin] of pins) {
    if (now - pin.at > 12000) {
      pins.delete(id);
      continue;
    }
    const [px, py] = worldToScreen(pin.x + 0.5, pin.y + 0.5);
    ctx.fillStyle = "#140e0a";
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = pin.color || "#e4b15a";
    ctx.beginPath();
    ctx.arc(px, py, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawMinimap() {
  const mini = $("mini");
  if (!mini) return;
  paintMapImage();
  const mctx = mini.getContext("2d");
  const w = mini.width;
  const h = mini.height;
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.fillStyle = "#0c0907";
  mctx.fillRect(0, 0, w, h);
  const pad = Math.max(2, Math.round(w * 0.04));
  const inner = w - pad * 2;
  mctx.imageSmoothingEnabled = false;
  mctx.drawImage(mapCanvas, pad, pad, inner, inner);
  mctx.strokeStyle = "rgba(228, 177, 90, 0.7)";
  mctx.lineWidth = 1;
  mctx.strokeRect(pad + 0.5, pad + 0.5, inner - 1, inner - 1);
  const halfW = cssW / 2 / cam.z;
  const halfH = cssH / 2 / cam.z;
  const rx = pad + ((cam.x - halfW) / boardSize) * inner;
  const ry = pad + ((cam.y - halfH) / boardSize) * inner;
  const rw = (halfW * 2 / boardSize) * inner;
  const rh = (halfH * 2 / boardSize) * inner;
  mctx.strokeStyle = "#f3e6cf";
  mctx.lineWidth = Math.max(1, w / 80);
  mctx.strokeRect(rx, ry, Math.max(2, rw), Math.max(2, rh));
  const now = performance.now();
  for (const pin of pins.values()) {
    if (now - pin.at > 12000) continue;
    mctx.fillStyle = pin.color || "#e4b15a";
    mctx.fillRect(
      pad + (pin.x / boardSize) * inner - 1,
      pad + (pin.y / boardSize) * inner - 1,
      3,
      3,
    );
  }
}

function draw() {
  easeCam();
  document.body.classList.toggle("far", usesOverview());
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = "#0c0907";
  ctx.fillRect(0, 0, cssW, cssH);

  const now = performance.now();
  const far = usesOverview();
  if (far) {
    drawOverview();
  } else {
    const v = viewRect();
    const gutter = cam.z > 22 ? 1.5 : 0;
    const x0 = Math.max(0, v.x0);
    const y0 = Math.max(0, v.y0);
    const x1 = Math.min(boardSize - 1, v.x1);
    const y1 = Math.min(boardSize - 1, v.y1);
    const numSize = Math.floor((cam.z - gutter) * 0.58);
    ctx.font = `700 ${numSize}px ${MONO}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const [sx, sy] = worldToScreen(x, y);
        if (sx > cssW || sy > cssH || sx + cam.z < 0 || sy + cam.z < 0) continue;
        const cell = cells.get(x + "," + y);
        drawCell(sx, sy, cam.z - gutter, x, y, cell, now);
      }
    }
    drawBoardEdge();

    if (hover && inBoard(hover[0], hover[1]) && !press?.moved) {
      const [sx, sy] = worldToScreen(hover[0], hover[1]);
      ctx.strokeStyle = "rgba(228, 177, 90, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sx + 0.5, sy + 0.5, cam.z - gutter - 1, cam.z - gutter - 1);
    }

    if (press && press.hold && !press.moved && inBoard(press.cell[0], press.cell[1])) {
      const [sx, sy] = worldToScreen(press.cell[0], press.cell[1]);
      const t = clamp((now - press.t) / 450, 0, 1);
      ctx.strokeStyle = `rgba(228, 177, 90, ${0.3 + t * 0.7})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx + cam.z / 2, sy + cam.z / 2, (cam.z / 2) * t, 0, Math.PI * 2);
      ctx.stroke();
    }

    for (const [id, c] of cursors) {
      if (now - c.at > 6000) {
        cursors.delete(id);
        continue;
      }
      if (!inBoard(c.x, c.y)) continue;
      drawCursor(c);
    }
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.life -= 0.03;
    if (p.life <= 0) {
      particles.splice(i, 1);
      continue;
    }
    ctx.globalAlpha = p.life;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x, p.y, 3, 3);
    ctx.globalAlpha = 1;
  }

  const center = cellAt(cssW / 2, cssH / 2);
  const coord = inBoard(center[0], center[1]) ? `${center[0]}, ${center[1]}` : "off the board";
  if (coord !== draw.coord) {
    draw.coord = coord;
    $("coords").textContent = coord;
  }
  drawMinimap();
  paintCool(now);
  paintRound();
  requestAnimationFrame(draw);
}

function drawCell(sx, sy, size, x, y, cell, now) {
  const g = grit(x, y);
  if (!cell) {
    ctx.fillStyle = `rgb(${54 + (g % 8)}, ${46 + (g % 5)}, ${34 + (g % 6)})`;
    ctx.fillRect(sx, sy, size, size);
    ctx.fillStyle = "rgba(255, 236, 210, 0.05)";
    ctx.fillRect(sx, sy, size, Math.max(1, size * 0.18));
    return;
  }
  if (cell.k === "f") {
    ctx.fillStyle = `rgb(${54 + (g % 8)}, ${46 + (g % 5)}, ${34 + (g % 6)})`;
    ctx.fillRect(sx, sy, size, size);
    drawFlag(sx, sy, size, cell.c || "#e4b15a");
    return;
  }
  if (cell.k === "m") {
    ctx.fillStyle = "#2a1612";
    ctx.fillRect(sx, sy, size, size);
    drawMine(sx, sy, size, cell.c || "#e4b15a");
    return;
  }
  ctx.fillStyle = `rgb(${228 - (g % 10)}, ${208 - (g % 8)}, ${168 - (g % 6)})`;
  ctx.fillRect(sx, sy, size, size);
  const flash = flashes.get(x + "," + y);
  if (flash && flash > now && cell.c) {
    ctx.fillStyle = cell.c;
    ctx.globalAlpha = ((flash - now) / 700) * 0.35;
    ctx.fillRect(sx, sy, size, size);
    ctx.globalAlpha = 1;
  } else if (flash) {
    flashes.delete(x + "," + y);
  }
  if (cell.n > 0 && size >= 16) {
    ctx.fillStyle = NUM[cell.n] || "#2a2118";
    ctx.fillText(String(cell.n), sx + size / 2, sy + size / 2 + 1);
  }
}

function drawFlag(sx, sy, size, color) {
  const x = sx + size * 0.38;
  const top = sy + size * 0.22;
  ctx.strokeStyle = "#1a120c";
  ctx.lineWidth = Math.max(1, size * 0.06);
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, sy + size * 0.78);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x + size * 0.34, top + size * 0.12);
  ctx.lineTo(x, top + size * 0.26);
  ctx.closePath();
  ctx.fill();
}

function drawMine(sx, sy, size, color) {
  const cx = sx + size / 2;
  const cy = sy + size / 2;
  const r = size * 0.16;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, size * 0.06);
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI * i) / 4;
    ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.lineTo(cx + Math.cos(a) * r * 2.1, cy + Math.sin(a) * r * 2.1);
  }
  ctx.stroke();
  ctx.fillStyle = "#e7d3b0";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawCursor(c) {
  const [sx, sy] = worldToScreen(c.x, c.y);
  const size = cam.z - 1.5;
  ctx.save();
  ctx.fillStyle = c.color;
  ctx.globalAlpha = 0.22;
  ctx.fillRect(sx + 1, sy + 1, size - 2, size - 2);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = c.color;
  ctx.lineWidth = 3;
  ctx.strokeRect(sx + 2, sy + 2, size - 4, size - 4);
  ctx.restore();
  if (cam.z < 20) return;
  ctx.font = `700 14px ${MONO}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const label = c.name;
  const w = ctx.measureText(label).width + 14;
  const lx = clamp(sx, 8, cssW - w - 8);
  const ly = Math.max(8, sy - 26);
  ctx.fillStyle = "#140e0a";
  ctx.fillRect(lx, ly, w, 22);
  ctx.fillStyle = c.color;
  ctx.fillRect(lx, ly, 4, 22);
  ctx.fillStyle = "#f3e6cf";
  ctx.fillText(label, lx + 10, ly + 11);
}

function paintCool(now) {
  const el = $("cool");
  const left = me.cooldownUntil - Date.now();
  if (left > 0) {
    el.hidden = false;
    const pct = clamp(left / 8000, 0, 1);
    $("cool-fill").style.width = `${pct * 100}%`;
    $("cool-label").textContent = `crater ${Math.ceil(left / 1000)}s`;
  } else if (!el.hidden) {
    el.hidden = true;
  }
  void now;
}

function localPoint(e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

let digTimer = 0;
let lastTap = { t: 0, x: 0, y: 0 };

function zoomInto(px, py) {
  zoomAt(px, py, clamp(Math.max(cam.z * 2.4, 22), minZoom(), 78), false);
}

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  const [px, py] = localPoint(e);
  pointers.set(e.pointerId, { x: px, y: py });
  if (pointers.size === 2) {
    const pts = [...pointers.values()];
    pinch = { d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), z: cam.z };
    if (press) press.moved = true;
    clearTimeout(digTimer);
    return;
  }
  if (e.button === 2) {
    if (usesOverview()) zoomInto(px, py);
    else {
      const cell = cellAt(px, py);
      flag(cell[0], cell[1]);
    }
    return;
  }
  if (e.button !== 0) return;
  press = { x: px, y: py, cell: cellAt(px, py), t: performance.now(), moved: false, hold: true, id: e.pointerId };
});

canvas.addEventListener("pointermove", (e) => {
  const [px, py] = localPoint(e);
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: px, y: py });
  hover = cellAt(px, py);
  maybeCursor(hover[0], hover[1]);

  if (pointers.size === 2 && pinch) {
    const pts = [...pointers.values()];
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (pinch.d > 0) {
      const next = clamp(pinch.z * (d / pinch.d), minZoom(), 78);
      zoomAt((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2, next, true);
    }
    return;
  }
  if (!press || press.id !== e.pointerId) return;
  const dx = px - press.x;
  const dy = py - press.y;
  if (!press.moved && dx * dx + dy * dy > 36) {
    press.moved = true;
    press.hold = false;
    press.lx = px;
    press.ly = py;
    clearTimeout(digTimer);
  }
  if (press.moved) {
    cam.x -= (px - press.lx) / cam.z;
    cam.y -= (py - press.ly) / cam.z;
    clampCamera(cam);
    goal.x = cam.x;
    goal.y = cam.y;
    goal.z = cam.z;
    press.lx = px;
    press.ly = py;
    scheduleView();
  }
});

canvas.addEventListener("pointerup", (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (!press || press.id !== e.pointerId) return;
  const held = performance.now() - press.t;
  const cell = press.cell;
  const moved = press.moved;
  const px = press.x;
  const py = press.y;
  press = null;
  if (moved || pointers.size > 0) return;
  if (usesOverview()) {
    zoomInto(px, py);
    return;
  }
  if (held >= 450) {
    flag(cell[0], cell[1]);
    return;
  }
  if (flagMode) {
    flag(cell[0], cell[1]);
    return;
  }
  const nowTap = performance.now();
  if (nowTap - lastTap.t < 450 && Math.hypot(px - lastTap.x, py - lastTap.y) < 28) {
    clearTimeout(digTimer);
    lastTap.t = 0;
    zoomAt(px, py, clamp(cam.z * 2, minZoom(), 78), false);
    return;
  }
  lastTap = { t: nowTap, x: px, y: py };
  clearTimeout(digTimer);
  digTimer = setTimeout(() => {
    dig(cell[0], cell[1]);
  }, 420);
});

canvas.addEventListener("pointercancel", (e) => {
  pointers.delete(e.pointerId);
  if (press?.id === e.pointerId) press = null;
});

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const [px, py] = localPoint(e);
  const factor = Math.exp(-e.deltaY * 0.0015);
  const base = easeCam.live ? goal.z : cam.z;
  zoomAt(px, py, clamp(base * factor, minZoom(), 78), false);
}, { passive: false });

function zoomAt(px, py, next, immediate) {
  const z = clamp(next, minZoom(), 78);
  const base = immediate || !easeCam.live ? cam : goal;
  const wx = base.x + (px - cssW / 2) / base.z;
  const wy = base.y + (py - cssH / 2) / base.z;
  goal.z = z;
  goal.x = wx - (px - cssW / 2) / z;
  goal.y = wy - (py - cssH / 2) / z;
  clampCamera(goal);
  if (immediate) {
    cam.x = goal.x;
    cam.y = goal.y;
    cam.z = goal.z;
    scheduleView();
  }
}

let lastCursorSent = 0;
let lastCursorCell = "";
function maybeCursor(x, y) {
  if (!inBoard(x, y)) return;
  const sig = x + "," + y;
  const now = performance.now();
  if (sig === lastCursorCell || now - lastCursorSent < 750) return;
  lastCursorCell = sig;
  lastCursorSent = now;
  send({ t: "cursor", x, y });
}

addEventListener("keydown", (e) => {
  if (e.target.matches?.("input")) return;
  const step = 80 / cam.z;
  if (e.key === "ArrowLeft" || e.key === "a") cam.x -= step;
  else if (e.key === "ArrowRight" || e.key === "d") cam.x += step;
  else if (e.key === "ArrowUp" || e.key === "w") cam.y -= step;
  else if (e.key === "ArrowDown" || e.key === "s") cam.y += step;
  else if (e.key === "f") toggleFlagMode();
  else if (e.key === "+" || e.key === "=") zoomAt(cssW / 2, cssH / 2, clamp((easeCam.live ? goal.z : cam.z) * 1.18, minZoom(), 78), false);
  else if (e.key === "-" || e.key === "_") zoomAt(cssW / 2, cssH / 2, clamp((easeCam.live ? goal.z : cam.z) / 1.18, minZoom(), 78), false);
  else if (e.key === "Escape") {
    setLeaderboard(false);
    e.preventDefault();
    return;
  }
  else return;
  if (e.key.startsWith("Arrow") || "wasd".includes(e.key)) {
    clampCamera(cam);
    goal.x = cam.x;
    goal.y = cam.y;
    goal.z = cam.z;
    scheduleView();
  }
  e.preventDefault();
});

function toggleFlagMode() {
  flagMode = !flagMode;
  $("flag-mode").setAttribute("aria-pressed", flagMode ? "true" : "false");
  canvas.style.cursor = flagMode ? "cell" : "crosshair";
}

$("flag-mode").addEventListener("click", toggleFlagMode);
$("zoom-in").addEventListener("click", () => {
  const z = easeCam.live ? goal.z : cam.z;
  zoomAt(cssW / 2, cssH / 2, clamp(z * 1.45, minZoom(), 78), false);
});
$("zoom-out").addEventListener("click", () => {
  const z = easeCam.live ? goal.z : cam.z;
  zoomAt(cssW / 2, cssH / 2, clamp(z / 1.45, minZoom(), 78), false);
});
$("origin").addEventListener("click", () => fitBoard());
$("mini").addEventListener("pointerdown", (e) => {
  e.preventDefault();
  e.stopPropagation();
  const r = $("mini").getBoundingClientRect();
  const u = clamp((e.clientX - r.left) / r.width, 0, 1);
  const v = clamp((e.clientY - r.top) / r.height, 0, 1);
  goal.x = u * boardSize;
  goal.y = v * boardSize;
  if (usesOverview()) goal.z = clamp(28, minZoom(), 48);
  clampCamera(goal);
});
function setChat(open) {
  $("chat").classList.toggle("open", open);
  $("chat").classList.toggle("shut", !open);
  const btn = $("chat-toggle");
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  btn.setAttribute("aria-pressed", open ? "true" : "false");
  if (open && matchMedia("(max-width: 800px)").matches) setLeaderboard(false);
}

function setLeaderboard(open) {
  $("notes").classList.toggle("open", open);
  $("notes").classList.toggle("shut", !open);
  const btn = $("notes-toggle");
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  btn.setAttribute("aria-pressed", open ? "true" : "false");
  if (open && matchMedia("(max-width: 800px)").matches) setChat(false);
}

setLeaderboard(!matchMedia("(max-width: 800px)").matches);
$("notes-toggle").addEventListener("click", () => setLeaderboard(!$("notes").classList.contains("open")));
$("close-notes").addEventListener("click", () => setLeaderboard(false));
$("chat-toggle").addEventListener("click", () => setChat(!$("chat").classList.contains("open")));
$("close-chat").addEventListener("click", () => setChat(false));
$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("chat-input");
  const text = input.value;
  if (!text.trim()) return;
  send({ t: "chat", text });
  input.value = "";
});

addEventListener("pointerdown", () => primeAudio(), true);
addEventListener("keydown", () => primeAudio(), true);

$("sound").setAttribute("aria-pressed", audioOn ? "true" : "false");
$("sound").addEventListener("click", () => {
  audioOn = !audioOn;
  localStorage.setItem("minesswept.sound", audioOn ? "1" : "0");
  $("sound").setAttribute("aria-pressed", audioOn ? "true" : "false");
  if (audioOn) {
    primeAudio();
    digSound();
  }
});

$("share").addEventListener("click", async () => {
  const url = location.origin;
  const text = `${me.name} — score ${fmt(me.score)}, ${fmt(me.clears)} dug on minesSwept. One board, everybody.`;
  try {
    if (navigator.share) {
      await navigator.share({ title: "minesSwept", text, url });
      return;
    }
  } catch {
    /* cancelled or unsupported */
  }
  try {
    await navigator.clipboard.writeText(`${text} ${url}`);
    toast("Copied. Go cause a scene.");
  } catch {
    toast(url);
  }
});

$("name").addEventListener("click", () => {
  const current = $("name");
  const input = document.createElement("input");
  input.className = "name-input";
  input.maxLength = 18;
  input.value = me.name === "…" ? "" : me.name;
  current.replaceWith(input);
  input.focus();
  input.select();
  const finish = (save) => {
    const value = input.value;
    input.replaceWith(current);
    if (save) {
      const cleaned = value.replace(/[^\p{L}\p{N} _.'-]/gu, "").trim().slice(0, 18);
      if (cleaned.length >= 2) {
        localStorage.setItem("minesswept.name", cleaned);
        me.name = cleaned;
        current.textContent = cleaned;
        send({ t: "name", name: cleaned });
      }
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
});

addEventListener("resize", resize);
resize();
connect();
requestAnimationFrame(draw);
setTimeout(dismissHint, 9000);
