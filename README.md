# 💣 Mines Swept

**A Social Experiment in Collaborative Minesweeper**

Everyone plays the same board. Every 3 seconds, the game processes all votes. Majority wins. Ties are resolved by coin flip.

## 🎮 How It Works

1. **Join the game** — Everyone sees the same 10x10 board
2. **Vote on actions** — Click to vote "reveal" or right-click to vote "flag"
3. **Wait for the tick** — Every 3 seconds, all votes are counted
4. **Majority wins** — The action with the most votes happens
5. **Ties = coin flip** — If it's 50/50, fate decides

## 🎯 The Experiment

Can a crowd collectively solve minesweeper? Or will chaos prevail?

- Will players coordinate?
- Will trolls try to hit bombs?
- Will democracy work?

## 🚀 Quick Start

### Using Docker Compose (Recommended)

```bash
docker-compose up --build
```

- Frontend: http://localhost:5000
- Backend: http://localhost:3000

### Local Development

**Backend:**
```bash
cd backend
npm install
npm run dev
```

**Frontend:**
```bash
cd frontend
npm install
npm start
```

## 🎮 Controls

| Action | Input |
|--------|-------|
| Vote to reveal | Left click |
| Vote to flag | Right click or Shift+click |
| Vote to unflag | Right click on flag |

## ⚙️ Game Config

Edit `backend/server.js` to change:

```javascript
const CONFIG = {
    gridSize: 10,      // Board size (10x10)
    bombCount: 15,     // Number of bombs
    tickInterval: 3000 // Tick every 3 seconds
};
```

## 🏗️ Architecture

```
┌─────────────────┐     WebSocket      ┌─────────────────┐
│                 │ ◄─────────────────► │                 │
│   React Client  │                     │  Node.js Server │
│                 │ ◄─────────────────► │                 │
└─────────────────┘     Socket.IO       └─────────────────┘
                                               │
                                               ▼
                                        ┌─────────────┐
                                        │  Game State │
                                        │  + Actions  │
                                        │   Queue     │
                                        └─────────────┘
                                               │
                                    Every 3 seconds (tick)
                                               │
                                               ▼
                                        ┌─────────────┐
                                        │  Process    │
                                        │   Votes     │
                                        │  Majority   │
                                        │   Wins      │
                                        └─────────────┘
```

## 📡 Socket Events

### Client → Server
- `action` — Queue an action: `{ x, y, type: 'reveal'|'flag'|'unflag' }`
- `resetGame` — Start a new game

### Server → Client
- `init` — Initial game state and player info
- `tick` — Tick results with updated grid
- `actionQueued` — Someone queued an action (for visual feedback)
- `playerJoined` / `playerLeft` — Player count updates
- `gameReset` — New game started

## 🔧 API Endpoints

- `GET /status` — Game status and stats
- `GET /grid` — Current public grid state

## 📁 Project Structure

```
mines-swept/
├── backend/
│   ├── server.js      # Game logic + WebSocket server
│   ├── package.json
│   └── Dockerfile
├── frontend/
│   ├── App.js         # React UI
│   ├── App.css        # Styling
│   ├── index.js       # Entry point
│   ├── package.json
│   └── Dockerfile
├── docker-compose.yml
└── README.md
```

## 🎲 Conflict Resolution

When multiple players vote on the same cell:

1. **Count votes** for each action type (reveal, flag, unflag)
2. **Majority wins** — The action with the most votes is executed
3. **Tie breaker** — If equal votes, a random coin flip decides

Example:
- 3 players vote "reveal" on cell [2,3]
- 2 players vote "flag" on cell [2,3]
- Result: Cell is revealed (3 > 2)

## 📜 License

GPL-3.0 — See LICENSE file

---

Built by [Telep IO](https://telep.io) as a social experiment 🧪
