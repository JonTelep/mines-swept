# minesSwept

One infinite minesweeper board. Everyone who opens the site is digging in the same dirt, and the holes stay dug.

No accounts. You get a name and a color, you can change the name, and you play. Other people show up as cursors. Their reveals land on your screen while you watch. Hit a mine and you sit in the crater for a few seconds — everyone else keeps going.

Built to be opened from a link and understood in about five seconds. The board is the whole product.

![Two players on the shared board](docs/board.png)

## Play

| | |
|---|---|
| Dig | Click or tap a hidden cell |
| Flag | Right-click, or press and hold, or toggle Flag |
| Chord | Tap a number whose flags already match it |
| Move | Drag, or arrow keys |
| Zoom | Scroll, pinch, or + / − |

Untouched ground will not kill you: if you dig a mine that nobody's numbers depend on yet, the mine is pushed somewhere else in that patch and your dig stands. Once a cell is next to opened ground, the numbers are locked and a wrong dig is yours alone. It costs 25 points (you can't go below zero) and an 8 second cooldown. Safe cells are worth 1 point each, cascades included.

The world runs from −1,000,000 to 1,000,000 on both axes. That is large enough to be endless in practice, and small enough to store.

## Run it locally

```bash
make dev
```

Open http://localhost:8787 in two windows. Both are on the same board. State is written to `.wrangler/state` and survives a restart of `wrangler dev`.

```bash
make test
```

Unit tests cover chunk-and-seed mine generation, flood fill, mine relocation, detonation, chords, and server-side rejection (bounds, flags, cooldown, rate limits). A second test starts `wrangler dev` and connects two WebSocket clients: each sees the other's flag and dig, hidden mine locations are never sent, and a flagged cell is still there after the dev server is killed and started again.

## Deploy

`make deploy` runs `wrangler deploy`. It expects `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment. The repo has no tokens and does not ask for any.

### One-time setup

1. Install [Wrangler](https://developers.cloudflare.com/workers/wrangler/) via `npm install` (the Makefile does this).
2. Create an API token that can edit Workers on the account that owns the `telep.io` zone. Export it as `CLOUDFLARE_API_TOKEN`, and export `CLOUDFLARE_ACCOUNT_ID`.
3. `wrangler.toml` already contains the custom domain route:

   ```toml
   [[routes]]
   pattern = "mines.telep.io"
   custom_domain = true
   ```

   The first successful deploy creates the `mines.telep.io` DNS record on that zone. The zone has to be in the same Cloudflare account. If you only want the `*.workers.dev` hostname first, comment those three lines out, deploy, then put them back.
4. Open https://mines.telep.io. Share cards are generated at `/og.png`. Live totals are at `/api/stats`.

Deploys restart the Durable Object and disconnect open sockets. SQLite state (every revealed cell, flag, and score) stays.

## Architecture

One Cloudflare Worker serves the static client and routes `/ws`, `/api/*`, and `/og.png` to a single SQLite-backed Durable Object named `world`.

Mines are not stored. A world seed plus the cell coordinate decides them, so the board can be enormous without writing the unrevealed field. Overrides (a relocated mine, or a mine planted to stop a runaway flood) and opened cells live in SQLite. Clients only ever receive cells that are already revealed or flagged.

Presence uses the WebSocket Hibernation API. The object sleeps between messages, which is what keeps the daily duration quota intact. Cursors are throttled and only forwarded to people looking at that patch. A dig is applied on the object, saved, and broadcast. There is one object on purpose: a shared board needs one authority, and one hibernating object can hold the sockets for a few hundred players. Splitting the field would make floods and the scoreboard lie.

## Free plan

Durable Objects with the SQLite backend are included on the Workers Free plan. The paid plan is not required to deploy or to run a normal launch. Figures below are from Cloudflare's pricing and limits docs as of 30 Sep 2026.

| Limit | Free allowance | What this game does |
|---|---|---|
| Worker requests | 100,000 / day | Static files are unlimited and do not count. The Worker runs for the WebSocket upgrade, `/api/stats`, and `/og.png`. |
| Worker CPU | 10 ms / request | The Worker only forwards. Game work runs in the Durable Object. |
| Durable Object requests | 100,000 / day | Incoming WebSocket messages are billed 20:1, so 2,000,000 incoming messages fit. Outgoing broadcasts are free. A connection setup counts as one request. |
| Durable Object duration | 13,000 GB-s / day | Hibernation means duration accrues only while a message is handled, not while people sit connected. |
| Durable Object CPU | 30 s / invocation by default | A single dig is capped at 400 cells. |
| SQLite rows read | 5 million / day | Viewport reads and per-cell lookups. |
| SQLite rows written | 100,000 / day | One row per revealed or flagged cell, plus the player and counter updates. This is the tight quota. |
| SQLite stored | 5 GB / account, 1 GB / object | Only opened cells and mine overrides. A million opened cells is still megabytes. |

Past a free-tier cap, that class of operation fails until 00:00 UTC. The client reconnects and the board is still there.

A rough fit: 80 people, each sending a cursor every couple of seconds and digging every few seconds, is on the order of 10,000 billed Durable Object requests per hour. A few hours of a popular post fits. A crowd of a couple hundred, panning hard all day, can spend the daily request budget. The $5 Workers Paid plan raises the ceiling (1 million Durable Object requests included per month, then $0.15 per million) and is not part of this deploy.

Per connection the server allows a handful of digs per second, a cell budget that refills, and at most 8 sockets from one IP. The object stops accepting new sockets around 500.

## License

GPL-3.0. See [LICENSE](LICENSE).
