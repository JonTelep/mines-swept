# minesSwept

One shared minesweeper round. Everyone who opens the site is digging in the same dirt. If anyone hits a mine, the round is over for everybody, and the person who did it gets a playful public shaming. Then a fresh board starts.

No accounts. You get a name and a color, you can change the name, and you play. Other people show up as cursors. There is one global chat. The longest anyone has kept a round alive is the number worth bragging about.

Built to be opened from a link and understood in about five seconds.

![Two players on the shared board](docs/board.png)

## Play

| | |
|---|---|
| Dig | Click or tap a hidden cell |
| Flag | Right-click, or press and hold, or toggle Flag |
| Chord | Tap a number whose flags already match it |
| Move | Drag, or arrow keys |
| Zoom | Scroll, pinch, or + / − |

Untouched ground will not end the round: if you dig a mine that nobody's numbers depend on yet, the mine is pushed somewhere else and your dig stands. Once a cell is next to opened ground, the numbers are locked. Hitting that mine ends the round for every player at once. The banner names who did it, how long the round lasted, how many cells were cleared, and how many people were on it. Mines around the blast are shown. After 15 seconds a new seed, an empty board, and the next round number start on their own. Safe cells are worth 1 point for that round. Scores reset with the board. The hall of shame and the longest-round record stay.

A round cannot be thrown in its first 20 seconds. During that grace, a frontier mine is moved instead of detonating. The player who just ended a round also cannot end the next one: their frontier mines are moved, and the field tells them this one isn't theirs to blow. One person cannot reset the game forever. Someone else has to do it.

The world runs from −1,000,000 to 1,000,000 on both axes. The current board lasts until someone blows it. History lasts.

Chat is one room on the same connection. The last hundred messages are kept for people who arrive late. Game-over lines are posted there automatically. One message every two seconds, 200 characters, plain text (a URL shows up as text and is not a link). A short server-side list rejects racial slurs, including spacing, leetspeak, repeated letters, and symbol swaps. Ordinary swearing is fine. The sender sees "Message not sent" and nobody else sees it. The same check applies to display names. The list itself is not printed here.

![The round ends for everyone](docs/shame.png)

![The same room, in chat](docs/chat.png)

## Run it locally

```bash
make dev
```

Open http://localhost:8787 in two windows. Both are on the same board. State is written to `.wrangler/state` and survives a restart of `wrangler dev`.

```bash
make test
```

Unit tests cover chunk-and-seed mine generation, flood fill, mine relocation, detonation, chords, server-side rejection, the slur filter (including evasions), chat length and rate limit, grace, the shield, and the shame line. Two wrangler tests connect real clients: one checks that a flag and a dig are shared and that hidden mines stay on the server, and the other checks chat, a blocked slur, a round ending for both players, the automatic next round, and that the hall of shame is still there after a restart.

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
| SQLite rows written | 100,000 / day | One row per revealed or flagged cell, plus one row per chat line. This is the tight quota. |
| SQLite stored | 5 GB / account, 1 GB / object | Only opened cells and mine overrides. A million opened cells is still megabytes. |

Past a free-tier cap, that class of operation fails until 00:00 UTC. The client reconnects and the board is still there.

A rough fit: 80 people, each sending a cursor every couple of seconds and digging every few seconds, is on the order of 10,000 billed Durable Object requests per hour. Chat is on that same budget. Incoming messages bill 20:1, so a person chatting at the cap (one line every two seconds) adds about 1,800 billed requests an hour. A few dozen people talking steadily is fine for an afternoon. A crowd all chatting at the cap also writes one SQLite row per line, and 100,000 writes a day is only a little over one write a second on average, so a busy room can spend the write quota before the request quota. Ending a round deletes one row per opened cell. A few hours of a popular post fits. A couple hundred people, panning and typing all day, can spend the daily budget. The $5 Workers Paid plan raises the ceiling (1 million Durable Object requests included per month, then $0.15 per million) and is not part of this deploy.

Per connection the server allows a handful of digs per second, a cell budget that refills, and at most 8 sockets from one IP. The object stops accepting new sockets around 500.

## License

GPL-3.0. See [LICENSE](LICENSE).
