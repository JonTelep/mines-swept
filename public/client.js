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

const cam = { x: 0.5, y: 0.5, z: 36 };
let cssW = 1;
let cssH = 1;
let dpr = 1;
let hover = null;
let flagMode = false;
let me = { id: "", name: "…", color: "#e4b15a", score: 0, clears: 0, booms: 0, cooldownUntil: 0 };
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
  const across = cssW < 700 ? 11 : 18;
  if (!resize.did) {
    cam.z = clamp(Math.floor(cssW / across), minZoom(), 48);
    resize.did = true;
  }
  scheduleView();
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function minZoom() {
  return Math.max(18, Math.ceil(Math.max(cssW, cssH) / 74));
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
}, 25000);

function onMsg(msg) {
  if (msg.t === "welcome") {
    me = { ...me, ...msg.you };
    localStorage.setItem("minesswept.name", me.name);
    paintHud(msg.stats);
    paintLeaders(msg.leaderboard || []);
    paintWho(msg.players || []);
    paintFeed(msg.feed?.[0]);
    applySnapshot(msg);
    $("online").textContent = `${msg.stats.online} sweeping`;
    return;
  }
  if (msg.t === "snapshot") {
    applySnapshot(msg);
    if (msg.cursors) for (const p of msg.cursors) noteCursor(p);
    return;
  }
  if (msg.t === "delta") {
    applyCells(msg.cells || [], true);
    if (msg.event) paintFeed(msg.event);
    if (msg.stats) paintHud(msg.stats);
    if (msg.leaderboard) paintLeaders(msg.leaderboard);
    if (msg.event?.type === "boom") punch();
    if (msg.event?.type === "clear" && msg.event.n > 12) blip(640, 0.08, "sine", 0.03);
    return;
  }
  if (msg.t === "you") {
    const wasCool = me.cooldownUntil;
    me = { ...me, ...msg };
    localStorage.setItem("minesswept.name", me.name);
    paintYou();
    if (msg.cooldownUntil > Date.now() && msg.cooldownUntil !== wasCool) {
      blip(90, 0.28, "triangle", 0.07);
      toast("Mine. The rest of the field keeps going.");
      $("live").textContent = "You hit a mine. Short cooldown.";
    }
    return;
  }
  if (msg.t === "presence") {
    if (msg.stats) paintHud(msg.stats);
    paintWho(msg.players || []);
    $("online").textContent = `${msg.stats.online} sweeping`;
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
      name: "Use at least two letters.",
      packed: "Too many sweepers. Try again in a minute.",
      server: "The field hiccuped. Try that again.",
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
}

function paintYou() {
  $("name").textContent = me.name;
  $("score").textContent = fmt(me.score);
  $("personal").textContent = `${fmt(me.clears)} dug · ${fmt(me.booms)} ${me.booms === 1 ? "mine" : "mines"}`;
}

function paintHud(stats) {
  paintYou();
  if (!stats) return;
  $("everyone").innerHTML = `<strong>${fmt(stats.cleared)}</strong> dug together`;
  if (alive) $("online").textContent = `${stats.online} sweeping`;
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

function blip(freq, dur, type, vol) {
  if (!audioOn) return;
  try {
    if (!actx) actx = new AudioContext();
    if (actx.state === "suspended") actx.resume();
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + dur);
    o.connect(g);
    g.connect(actx.destination);
    o.start();
    o.stop(actx.currentTime + dur);
  } catch {
    /* autoplay or missing audio */
  }
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
  if (flagMode) {
    send({ t: "flag", x, y });
    blip(360, 0.04, "square", 0.02);
    return;
  }
  send({ t: "reveal", x, y });
  blip(520, 0.05, "sine", 0.035);
}

function flag(x, y) {
  dismissHint();
  send({ t: "flag", x, y });
  blip(360, 0.04, "square", 0.02);
}

function dismissHint() {
  if (hinted) return;
  hinted = true;
  $("hint").classList.add("gone");
}

function draw() {
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = "#140e0a";
  ctx.fillRect(0, 0, cssW, cssH);

  const v = viewRect();
  const gutter = cam.z > 22 ? 1.5 : 0;
  const now = performance.now();
  const numSize = Math.floor((cam.z - gutter) * 0.58);
  ctx.font = `700 ${numSize}px ${MONO}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let y = v.y0; y <= v.y1; y++) {
    for (let x = v.x0; x <= v.x1; x++) {
      const [sx, sy] = worldToScreen(x, y);
      if (sx > cssW || sy > cssH || sx + cam.z < 0 || sy + cam.z < 0) continue;
      const cell = cells.get(x + "," + y);
      drawCell(sx, sy, cam.z - gutter, x, y, cell, now);
    }
  }

  if (hover && !press?.moved) {
    const [sx, sy] = worldToScreen(hover[0], hover[1]);
    ctx.strokeStyle = "rgba(228, 177, 90, 0.9)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(sx + 0.5, sy + 0.5, cam.z - gutter - 1, cam.z - gutter - 1);
  }

  if (press && press.hold && !press.moved) {
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
    drawCursor(c);
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
  const coord = `${center[0]}, ${center[1]}`;
  if (coord !== draw.coord) {
    draw.coord = coord;
    $("coords").textContent = coord;
  }
  paintCool(now);
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

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  const [px, py] = localPoint(e);
  pointers.set(e.pointerId, { x: px, y: py });
  if (pointers.size === 2) {
    const pts = [...pointers.values()];
    pinch = { d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), z: cam.z };
    if (press) press.moved = true;
    return;
  }
  if (e.button === 2) {
    const cell = cellAt(px, py);
    flag(cell[0], cell[1]);
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
      zoomAt((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2, next);
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
  }
  if (press.moved) {
    cam.x -= (px - press.lx) / cam.z;
    cam.y -= (py - press.ly) / cam.z;
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
  press = null;
  if (moved) return;
  if (held >= 450) flag(cell[0], cell[1]);
  else dig(cell[0], cell[1]);
});

canvas.addEventListener("pointercancel", (e) => {
  pointers.delete(e.pointerId);
  if (press?.id === e.pointerId) press = null;
});

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const [px, py] = localPoint(e);
  const factor = Math.exp(-e.deltaY * 0.0011);
  zoomAt(px, py, clamp(cam.z * factor, minZoom(), 78));
}, { passive: false });

function zoomAt(px, py, next) {
  const [wx, wy] = screenToWorld(px, py);
  cam.z = next;
  cam.x = wx - (px - cssW / 2) / cam.z;
  cam.y = wy - (py - cssH / 2) / cam.z;
  scheduleView();
}

let lastCursorSent = 0;
let lastCursorCell = "";
function maybeCursor(x, y) {
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
  else if (e.key === "+" || e.key === "=") zoomAt(cssW / 2, cssH / 2, clamp(cam.z * 1.12, minZoom(), 78));
  else if (e.key === "-" || e.key === "_") zoomAt(cssW / 2, cssH / 2, clamp(cam.z / 1.12, minZoom(), 78));
  else if (e.key === "Escape") $("notes").classList.remove("open");
  else return;
  scheduleView();
  e.preventDefault();
});

function toggleFlagMode() {
  flagMode = !flagMode;
  $("flag-mode").setAttribute("aria-pressed", flagMode ? "true" : "false");
  canvas.style.cursor = flagMode ? "cell" : "crosshair";
}

$("flag-mode").addEventListener("click", toggleFlagMode);
$("zoom-in").addEventListener("click", () => zoomAt(cssW / 2, cssH / 2, clamp(cam.z * 1.15, minZoom(), 78)));
$("zoom-out").addEventListener("click", () => zoomAt(cssW / 2, cssH / 2, clamp(cam.z / 1.15, minZoom(), 78)));
$("origin").addEventListener("click", () => {
  cam.x = 0.5;
  cam.y = 0.5;
  scheduleView();
});
$("notes-toggle").addEventListener("click", () => $("notes").classList.toggle("open"));
$("close-notes").addEventListener("click", () => $("notes").classList.remove("open"));

$("sound").setAttribute("aria-pressed", audioOn ? "true" : "false");
$("sound").addEventListener("click", () => {
  audioOn = !audioOn;
  localStorage.setItem("minesswept.sound", audioOn ? "1" : "0");
  $("sound").setAttribute("aria-pressed", audioOn ? "true" : "false");
  if (audioOn) blip(520, 0.06, "sine", 0.04);
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
