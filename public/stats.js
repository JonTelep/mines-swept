const $ = (id) => document.getElementById(id);
const ROWS = [
  ["visitors", "Players"],
  ["newPlayers", "New players"],
  ["sessions", "Sessions"],
  ["digs", "Digs"],
  ["cleared", "Cells cleared"],
  ["flags", "Flags"],
  ["booms", "Bombs"],
  ["chats", "Chat messages"],
  ["roundsEnded", "Rounds blown"],
  ["roundsWon", "Rounds won"],
  ["peakOnline", "Peak online"],
];
const METRIC_LABEL = {
  cleared: "cells cleared",
  digs: "digs",
  booms: "bombs",
  visitors: "players",
  flags: "flags",
};

let range = "7d";
let metric = "cleared";
let payload = null;

function fmt(n) {
  return Math.max(0, Number(n) || 0).toLocaleString("en-US");
}

function clock(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(sec).padStart(2, "0")}s`;
}

function when(ts, grain) {
  const d = new Date(ts);
  if (grain === "hour") {
    return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric" });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function paint(data) {
  payload = data;
  const all = data.allTime || {};
  const today = data.today || {};
  $("h-players").textContent = fmt(all.visitors);
  $("h-digs").textContent = fmt(all.digs);
  $("h-bombs").textContent = fmt(all.booms);
  $("h-cleared").textContent = fmt(all.cleared);
  $("lede").textContent = `${fmt(all.visitors)} players, ${fmt(all.digs)} digs, ${fmt(all.booms)} bombs. ${fmt(today.digs)} of those digs were today.`;
  if (data.born) {
    const opened = new Date(data.born).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    $("since").textContent = `One board, open since ${opened}`;
  }
  const live = data.live || {};
  const people = live.online === 1 ? "1 person sweeping" : `${fmt(live.online || 0)} sweeping`;
  $("status").textContent = live.round
    ? `Round #${live.round} · ${people} · ${fmt(live.roundCleared || 0)} cleared this round`
    : "The board is answering.";

  const body = $("compare");
  body.replaceChildren();
  for (const [key, label] of ROWS) {
    const tr = document.createElement("tr");
    for (const text of [label, fmt(today[key]), fmt(all[key])]) {
      const cell = document.createElement(text === label ? "th" : "td");
      if (text === label) cell.scope = "row";
      cell.textContent = text;
      tr.append(cell);
    }
    body.append(tr);
  }

  const best = data.best || {};
  $("best").textContent = best.ms
    ? `Longest round #${best.round} lasted ${clock(best.ms)}${best.name ? `, ended by ${best.name}` : ""}`
    : "No round has ended yet.";
  paintList("shame", data.shame || [], (row) => `#${row.n} · ${clock(row.durationMs)} · ${fmt(row.cleared)}`);
  paintList("fame", data.fame || [], (row) => `#${row.n} · ${clock(row.durationMs)} · ${fmt(row.cleared)}`);
  paintList("leaders", data.leaderboard || [], (row) => `${fmt(row.score)} · ${fmt(row.clears)} dug`);
  $("shame-empty").hidden = (data.shame || []).length > 0;
  $("fame-empty").hidden = (data.fame || []).length > 0;
  $("leaders-empty").hidden = (data.leaderboard || []).length > 0;
  $("live-line").textContent = people;
  drawChart(data);
}

function paintList(id, rows, meta) {
  const ol = $(id);
  ol.replaceChildren();
  for (const row of rows) {
    const li = document.createElement("li");
    const who = document.createElement("span");
    who.style.color = row.color || "#e4b15a";
    who.textContent = row.name || "Someone";
    const tail = document.createElement("span");
    tail.textContent = meta(row);
    li.append(who, tail);
    ol.append(li);
  }
}

function drawChart(data) {
  const svg = $("chart");
  const series = data.series || [];
  const label = METRIC_LABEL[metric] || metric;
  const values = series.map((row) => Math.max(0, Number(row[metric]) || 0));
  const max = Math.max(1, ...values);
  const total = values.reduce((sum, n) => sum + n, 0);
  svg.replaceChildren();
  const ns = "http://www.w3.org/2000/svg";
  const w = 960;
  const h = 280;
  const pad = 16;
  const gap = series.length > 40 ? 2 : 6;
  const barW = series.length ? (w - pad * 2 - gap * (series.length - 1)) / series.length : 0;
  values.forEach((value, i) => {
    const bh = value ? Math.max(2, ((h - 36) * value) / max) : 0;
    const x = pad + i * (barW + gap);
    const y = h - 24 - bh;
    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", x.toFixed(2));
    rect.setAttribute("y", y.toFixed(2));
    rect.setAttribute("width", Math.max(1, barW).toFixed(2));
    rect.setAttribute("height", bh.toFixed(2));
    rect.setAttribute("fill", metric === "booms" ? "#d4533a" : metric === "visitors" ? "#8eae78" : "#e4b15a");
    const title = document.createElementNS(ns, "title");
    title.textContent = `${when(series[i].t, data.grain)}: ${fmt(value)} ${label}`;
    rect.append(title);
    svg.append(rect);
  });
  const caption = document.createElementNS(ns, "text");
  caption.setAttribute("x", "16");
  caption.setAttribute("y", "18");
  caption.setAttribute("fill", "#ead7b4");
  caption.setAttribute("font-family", "ui-monospace, Menlo, Consolas, monospace");
  caption.setAttribute("font-size", "13");
  caption.textContent = `${fmt(total)} ${label} in this window`;
  svg.append(caption);
  $("chart-summary").textContent = series.length
    ? `${fmt(total)} ${label} from ${when(series[0].t, data.grain)} to ${when(series[series.length - 1].t, data.grain)}. Each bar is one ${data.grain}.`
    : "Nothing in this window yet.";
}

async function load() {
  const res = await fetch(`/api/stats/history?range=${encodeURIComponent(range)}`);
  if (!res.ok) throw new Error(String(res.status));
  paint(await res.json());
}

for (const button of document.querySelectorAll("[data-range]")) {
  button.addEventListener("click", () => {
    range = button.dataset.range;
    for (const other of document.querySelectorAll("[data-range]")) {
      other.setAttribute("aria-pressed", other === button ? "true" : "false");
    }
    load().catch(fail);
  });
}

for (const button of document.querySelectorAll("[data-metric]")) {
  button.addEventListener("click", () => {
    metric = button.dataset.metric;
    for (const other of document.querySelectorAll("[data-metric]")) {
      other.setAttribute("aria-pressed", other === button ? "true" : "false");
    }
    if (payload) drawChart(payload);
  });
}

function fail() {
  $("status").textContent = "The field didn't answer. Try again in a moment.";
}

load().catch(fail);
setInterval(() => load().catch(fail), 20000);
