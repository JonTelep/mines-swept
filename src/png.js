// Tiny PNG encoder plus a 5×7 field-radio font for the share card.
// Flat colors compress well; this stays a small dynamic response.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc);
  return out;
}

async function zlib(data) {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodePNG(width, height, rgba) {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const dest = y * (width * 4 + 1);
    raw[dest] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), dest + 1);
  }
  const idat = await zlib(raw);
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array())];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

// 5×7 glyphs, left to right, top row first. Space is empty.
const GLYPHS = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "01010", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ",": ["00000", "00000", "00000", "00000", "00100", "00100", "01000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "'": ["00100", "00100", "01000", "00000", "00000", "00000", "00000"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

export function measureText(text, scale) {
  return text.length * 6 * scale - scale;
}

export function drawText(rgba, width, text, x, y, scale, color) {
  const upper = text.toUpperCase();
  let cx = x;
  for (const ch of upper) {
    const glyph = GLYPHS[ch] || GLYPHS[" "];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] !== "1") continue;
        fillRect(rgba, width, cx + col * scale, y + row * scale, scale, scale, color);
      }
    }
    cx += 6 * scale;
  }
}

export function fillRect(rgba, width, x, y, w, h, color) {
  const x0 = Math.max(0, x | 0);
  const y0 = Math.max(0, y | 0);
  const x1 = Math.min(width, (x + w) | 0);
  const y1 = Math.min((rgba.length / 4 / width) | 0, (y + h) | 0);
  for (let yy = y0; yy < y1; yy++) {
    let i = (yy * width + x0) * 4;
    for (let xx = x0; xx < x1; xx++) {
      rgba[i] = color[0];
      rgba[i + 1] = color[1];
      rgba[i + 2] = color[2];
      rgba[i + 3] = 255;
      i += 4;
    }
  }
}

function hex(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

function formatCount(n) {
  return Math.max(0, n | 0).toLocaleString("en-US");
}

export async function renderShareCard(stats) {
  const width = 1200;
  const height = 630;
  const rgba = new Uint8Array(width * height * 4);
  const ink = hex("#140e0a");
  const soil = hex("#2a241c");
  const paper = hex("#e7d3b0");
  const brass = hex("#e4b15a");
  const moss = hex("#8eae78");
  const crater = hex("#d4533a");

  fillRect(rgba, width, 0, 0, width, height, ink);

  // A faint tile field behind the type, so the card looks like the game.
  for (let y = 70; y < height - 70; y += 36) {
    for (let x = 60; x < width - 60; x += 36) {
      const alt = ((x / 36 + y / 36) | 0) % 2 === 0;
      fillRect(rgba, width, x, y, 32, 32, alt ? soil : [36, 31, 24]);
    }
  }
  fillRect(rgba, width, 70, 78, 1060, 474, ink);
  fillRect(rgba, width, 88, 96, 1024, 438, [22, 17, 13]);

  drawText(rgba, width, "MINESSWEPT", 118, 140, 8, brass);
  drawText(rgba, width, "ONE BOARD. EVERYBODY.", 118, 214, 4, moss);

  const dug = formatCount(stats.cleared || 0);
  let scale = 14;
  while (scale > 6 && measureText(dug, scale) > 640) scale -= 2;
  drawText(rgba, width, dug, 118, 290, scale, paper);
  const numberWidth = measureText(dug, scale);
  const labelY = 290 + scale * 7 - 28;
  const labelX = 118 + numberWidth + 28;
  if (labelX < 980) drawText(rgba, width, "CELLS CLEARED", labelX, labelY, 4, brass);

  const bombs = `${formatCount(stats.booms || 0)} BOMBS`;
  const online = `${formatCount(stats.online || 0)} ON THE BOARD`;
  drawText(rgba, width, bombs, 118, 448, 4, crater);
  drawText(rgba, width, online, 118 + measureText(bombs, 4) + 40, 448, 4, moss);
  const players = stats.visitors > 0 ? `${formatCount(stats.visitors)} PLAYERS` : "";
  if (players) drawText(rgba, width, players, 118, 490, 3, paper);
  drawText(rgba, width, "MINESSWEPT.COM", 760, players ? 490 : 448, 4, crater);

  return encodePNG(width, height, rgba);
}
