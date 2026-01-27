// server.js - Tick-based Multiplayer Minesweeper
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());

// ============== GAME CONFIG ==============
const CONFIG = {
    gridSize: 10,
    bombCount: 15,
    tickInterval: 3000, // 3 seconds
};

// ============== GAME STATE ==============
let gameState = {
    grid: [],
    isGameOver: false,
    isWin: false,
    tickNumber: 0,
    players: new Map(), // socket.id -> { name, color }
    pendingActions: [], // Actions queued for next tick
    lastTickTime: Date.now(),
    revealedCount: 0,
    flaggedCount: 0,
};

// ============== CELL STRUCTURE ==============
// Each cell has:
// - isBomb: boolean
// - adjacentBombs: number (0-8)
// - state: 'hidden' | 'revealed' | 'flagged'

function generateGrid(size, bombCount) {
    // Create empty grid
    const grid = Array.from({ length: size }, () =>
        Array.from({ length: size }, () => ({
            isBomb: false,
            adjacentBombs: 0,
            state: 'hidden'
        }))
    );

    // Place bombs randomly
    let bombsPlaced = 0;
    while (bombsPlaced < bombCount) {
        const x = Math.floor(Math.random() * size);
        const y = Math.floor(Math.random() * size);
        if (!grid[x][y].isBomb) {
            grid[x][y].isBomb = true;
            bombsPlaced++;
        }
    }

    // Calculate adjacent bomb counts
    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            if (!grid[x][y].isBomb) {
                let count = 0;
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx >= 0 && nx < size && ny >= 0 && ny < size && grid[nx][ny].isBomb) {
                            count++;
                        }
                    }
                }
                grid[x][y].adjacentBombs = count;
            }
        }
    }

    return grid;
}

function resetGame() {
    gameState.grid = generateGrid(CONFIG.gridSize, CONFIG.bombCount);
    gameState.isGameOver = false;
    gameState.isWin = false;
    gameState.tickNumber = 0;
    gameState.pendingActions = [];
    gameState.revealedCount = 0;
    gameState.flaggedCount = 0;
    gameState.lastTickTime = Date.now();
    console.log(`🎮 New game started! ${CONFIG.gridSize}x${CONFIG.gridSize} grid with ${CONFIG.bombCount} bombs`);
}

// ============== ACTION PROCESSING ==============
// Action types: 'reveal', 'flag', 'unflag'

function processActions(actions) {
    if (gameState.isGameOver) return [];

    // Group actions by cell
    const cellActions = new Map(); // "x,y" -> { reveal: [], flag: [], unflag: [] }

    for (const action of actions) {
        const key = `${action.x},${action.y}`;
        if (!cellActions.has(key)) {
            cellActions.set(key, { reveal: [], flag: [], unflag: [] });
        }
        cellActions.get(key)[action.type].push(action);
    }

    const results = [];

    // Process each cell
    for (const [key, votes] of cellActions) {
        const [x, y] = key.split(',').map(Number);
        const cell = gameState.grid[x][y];

        // Skip already revealed cells
        if (cell.state === 'revealed') continue;

        // Count votes
        const revealVotes = votes.reveal.length;
        const flagVotes = votes.flag.length;
        const unflagVotes = votes.unflag.length;

        // Determine winning action
        let winningAction = null;
        const maxVotes = Math.max(revealVotes, flagVotes, unflagVotes);

        if (maxVotes === 0) continue;

        // Find all actions with max votes
        const tiedActions = [];
        if (revealVotes === maxVotes) tiedActions.push('reveal');
        if (flagVotes === maxVotes) tiedActions.push('flag');
        if (unflagVotes === maxVotes) tiedActions.push('unflag');

        // Resolve ties with coin flip
        if (tiedActions.length > 1) {
            winningAction = tiedActions[Math.floor(Math.random() * tiedActions.length)];
            results.push({
                x, y,
                action: winningAction,
                votes: maxVotes,
                wasTie: true,
                tiedWith: tiedActions
            });
        } else {
            winningAction = tiedActions[0];
            results.push({
                x, y,
                action: winningAction,
                votes: maxVotes,
                wasTie: false
            });
        }

        // Execute the winning action
        if (winningAction === 'reveal') {
            revealCell(x, y);
        } else if (winningAction === 'flag' && cell.state === 'hidden') {
            cell.state = 'flagged';
            gameState.flaggedCount++;
        } else if (winningAction === 'unflag' && cell.state === 'flagged') {
            cell.state = 'hidden';
            gameState.flaggedCount--;
        }
    }

    return results;
}

function revealCell(x, y) {
    const cell = gameState.grid[x][y];
    if (cell.state !== 'hidden') return;

    cell.state = 'revealed';
    gameState.revealedCount++;

    if (cell.isBomb) {
        // Game over - reveal all bombs
        gameState.isGameOver = true;
        gameState.isWin = false;
        revealAllBombs();
        return;
    }

    // Check win condition
    const totalSafeCells = CONFIG.gridSize * CONFIG.gridSize - CONFIG.bombCount;
    if (gameState.revealedCount >= totalSafeCells) {
        gameState.isGameOver = true;
        gameState.isWin = true;
        return;
    }

    // Auto-reveal adjacent cells if this cell has 0 adjacent bombs
    if (cell.adjacentBombs === 0) {
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx >= 0 && nx < CONFIG.gridSize && ny >= 0 && ny < CONFIG.gridSize) {
                    revealCell(nx, ny);
                }
            }
        }
    }
}

function revealAllBombs() {
    for (let x = 0; x < CONFIG.gridSize; x++) {
        for (let y = 0; y < CONFIG.gridSize; y++) {
            if (gameState.grid[x][y].isBomb) {
                gameState.grid[x][y].state = 'revealed';
            }
        }
    }
}

// ============== TICK SYSTEM ==============
function tick() {
    if (gameState.isGameOver) {
        // Clear pending actions but don't process
        gameState.pendingActions = [];
        return;
    }

    gameState.tickNumber++;
    const actionsToProcess = [...gameState.pendingActions];
    gameState.pendingActions = [];
    gameState.lastTickTime = Date.now();

    const results = processActions(actionsToProcess);

    // Broadcast tick results
    io.emit('tick', {
        tickNumber: gameState.tickNumber,
        results,
        grid: getPublicGrid(),
        isGameOver: gameState.isGameOver,
        isWin: gameState.isWin,
        stats: getStats(),
        nextTickIn: CONFIG.tickInterval
    });

    console.log(`⏰ Tick #${gameState.tickNumber}: Processed ${actionsToProcess.length} actions, ${results.length} cells affected`);
}

// Start the tick loop
setInterval(tick, CONFIG.tickInterval);

// ============== HELPERS ==============
function getPublicGrid() {
    // Return grid without revealing bomb locations for hidden cells
    return gameState.grid.map((row, x) =>
        row.map((cell, y) => ({
            x,
            y,
            state: cell.state,
            adjacentBombs: cell.state === 'revealed' ? cell.adjacentBombs : null,
            isBomb: cell.state === 'revealed' ? cell.isBomb : null
        }))
    );
}

function getStats() {
    return {
        tickNumber: gameState.tickNumber,
        playerCount: gameState.players.size,
        pendingActions: gameState.pendingActions.length,
        revealedCount: gameState.revealedCount,
        flaggedCount: gameState.flaggedCount,
        totalCells: CONFIG.gridSize * CONFIG.gridSize,
        bombCount: CONFIG.bombCount,
        timeToNextTick: CONFIG.tickInterval - (Date.now() - gameState.lastTickTime)
    };
}

function getPlayerColors() {
    const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F'];
    return colors[gameState.players.size % colors.length];
}

// ============== SOCKET HANDLERS ==============
io.on('connection', (socket) => {
    // Assign player info
    const playerColor = getPlayerColors();
    const playerName = `Player ${gameState.players.size + 1}`;
    gameState.players.set(socket.id, { name: playerName, color: playerColor });

    console.log(`👤 ${playerName} connected (${gameState.players.size} total)`);

    // Send initial state
    socket.emit('init', {
        playerId: socket.id,
        playerName,
        playerColor,
        config: CONFIG,
        grid: getPublicGrid(),
        stats: getStats(),
        isGameOver: gameState.isGameOver,
        isWin: gameState.isWin
    });

    // Broadcast player joined
    io.emit('playerJoined', {
        playerId: socket.id,
        playerName,
        playerCount: gameState.players.size
    });

    // Handle player action
    socket.on('action', (data) => {
        if (gameState.isGameOver) return;

        const { x, y, type } = data;

        // Validate action
        if (x < 0 || x >= CONFIG.gridSize || y < 0 || y >= CONFIG.gridSize) return;
        if (!['reveal', 'flag', 'unflag'].includes(type)) return;

        // Queue the action
        gameState.pendingActions.push({
            playerId: socket.id,
            playerName: gameState.players.get(socket.id)?.name,
            x,
            y,
            type,
            timestamp: Date.now()
        });

        // Broadcast pending action to all clients (for visual feedback)
        io.emit('actionQueued', {
            playerId: socket.id,
            playerName: gameState.players.get(socket.id)?.name,
            playerColor: gameState.players.get(socket.id)?.color,
            x,
            y,
            type,
            pendingCount: gameState.pendingActions.length
        });
    });

    // Handle reset request
    socket.on('resetGame', () => {
        resetGame();
        io.emit('gameReset', {
            grid: getPublicGrid(),
            stats: getStats()
        });
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        const player = gameState.players.get(socket.id);
        gameState.players.delete(socket.id);
        console.log(`👤 ${player?.name || 'Unknown'} disconnected (${gameState.players.size} remaining)`);

        io.emit('playerLeft', {
            playerId: socket.id,
            playerName: player?.name,
            playerCount: gameState.players.size
        });
    });
});

// ============== HTTP ENDPOINTS ==============
app.get('/status', (req, res) => {
    res.json({
        status: 'running',
        config: CONFIG,
        stats: getStats(),
        isGameOver: gameState.isGameOver,
        isWin: gameState.isWin
    });
});

app.get('/grid', (req, res) => {
    res.json(getPublicGrid());
});

// ============== START SERVER ==============
resetGame(); // Initialize first game

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎮 Mines Swept server running on port ${PORT}`);
    console.log(`⏰ Tick interval: ${CONFIG.tickInterval}ms`);
    console.log(`📐 Grid: ${CONFIG.gridSize}x${CONFIG.gridSize} with ${CONFIG.bombCount} bombs`);
});
