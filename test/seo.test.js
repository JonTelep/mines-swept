import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pub = join(root, "public");

const LINKS = [
  ["https://telep.io/", "telep.io websites for small businesses"],
  ["https://bloomer.news/", "Bloomer News, positive AI news"],
  ["https://starterloot.com/", "StarterLoot, free AI tools for game devs"],
  ["https://publaish.com/", "Publaish, AI search visibility tracker"],
  ["https://openmedina.org/", "OpenMedina, open government for Medina County"],
  ["https://letstalkstatistics.com/", "Let's Talk Statistics, official figures with sources"],
  ["https://memes.telep.io/", "telep.io memes"],
  ["https://white.telep.io/", "white.telep.io, filming light and camera test"],
  ["https://seo.telep.io/", "AskMentions, see if AI answers mention you"],
];

function walkHtml(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkHtml(path, acc);
    else if (name.endsWith(".html")) acc.push(path);
  }
  return acc;
}

function footer(html, file) {
  const match = html.match(/<footer class="other-sites">([\s\S]*?)<\/footer>/);
  assert.ok(match, `${file} is missing the other-sites footer`);
  return match[1];
}

test("every public page shows the same plain other-sites links", () => {
  const files = walkHtml(pub);
  assert.ok(files.length >= 2);
  for (const file of files) {
    const html = readFileSync(file, "utf8");
    const block = footer(html, file);
    assert.equal(/[\u2013\u2014]/.test(block), false, file);
    assert.equal(/nofollow|ugc|sponsored/i.test(block), false, file);
    assert.equal(/display\s*:\s*none|visibility\s*:\s*hidden|aria-hidden/i.test(block), false, file);
    assert.equal(/<a\b[^>]*\srel=/i.test(block), false, file);
    assert.match(block, /Our other sites:/);
    assert.equal(block.includes("minesswept.com"), false, file);
    const links = [...block.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((item) => [item[1], item[2]]);
    assert.deepEqual(links, LINKS, file);
  }
});

test("sitemap lists each canonical page once", () => {
  const files = walkHtml(pub);
  const canonicals = [];
  for (const file of files) {
    const html = readFileSync(file, "utf8");
    const found = [...html.matchAll(/<link rel="canonical" href="([^"]+)"\s*\/?>/g)].map((item) => item[1]);
    assert.equal(found.length, 1, file);
    canonicals.push(found[0]);
  }
  canonicals.sort();
  const xml = readFileSync(join(pub, "sitemap.xml"), "utf8");
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((item) => item[1]).sort();
  assert.deepEqual(locs, canonicals);
  assert.equal(new Set(locs).size, locs.length);
  const robots = readFileSync(join(pub, "robots.txt"), "utf8");
  assert.match(robots, /^Sitemap: https:\/\/minesswept\.com\/sitemap\.xml$/m);
});
