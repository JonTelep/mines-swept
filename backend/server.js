// server.js - Tick-based Multiplayer Minesweeper
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const db = require('./db');

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
    players: new Map(), // socket.id -> { name, color, stats: { reveals, flags, unflags }, persistentId }
    pendingActions: [], // Actions queued for next tick
    lastTickTime: Date.now(),
    revealedCount: 0,
    flaggedCount: 0,
    actionHistory: [], // Circular buffer, max 50 entries
    gameOverPlayer: null, // { playerId, playerName, playerColor } - who caused game over
    currentGameId: null, // Database game ID
    gameStartTime: Date.now(),
    totalActions: 0,
    totalReveals: 0,
    totalFlags: 0,
    totalUnflags: 0,
};

// Rate limiting for player actions
const playerVoteLimits = new Map(); // socketId -> { count, resetTime }
const MAX_VOTES_PER_TICK = 1; // Each player gets ONE vote per tick - makes them think strategically!

// Debounced player list updates
let playerListUpdateQueued = false;
function queuePlayerListUpdate() {
    if (!playerListUpdateQueued) {
        playerListUpdateQueued = true;
        setTimeout(() => {
            io.emit('playerListUpdate', getPlayerList());
            playerListUpdateQueued = false;
        }, 500); // Batch updates every 500ms
    }
}

// ============== CELL STRUCTURE ==============
// Each cell has:
// - isBomb: boolean
// - adjacentBombs: number (0-8)
// - state: 'hidden' | 'revealed' | 'flagged'
// - revealedBy: { playerId, playerName, playerColor } | null

function generateGrid(size, bombCount) {
    // Create empty grid
    const grid = Array.from({ length: size }, () =>
        Array.from({ length: size }, () => ({
            isBomb: false,
            adjacentBombs: 0,
            state: 'hidden',
            revealedBy: null
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

async function resetGame() {
    gameState.grid = generateGrid(CONFIG.gridSize, CONFIG.bombCount);
    gameState.isGameOver = false;
    gameState.isWin = false;
    gameState.tickNumber = 0;
    gameState.pendingActions = [];
    gameState.revealedCount = 0;
    gameState.flaggedCount = 0;
    gameState.lastTickTime = Date.now();
    gameState.actionHistory = [];
    gameState.gameOverPlayer = null;
    gameState.gameStartTime = Date.now();
    gameState.totalActions = 0;
    gameState.totalReveals = 0;
    gameState.totalFlags = 0;
    gameState.totalUnflags = 0;

    // Reset player stats
    for (const [playerId, player] of gameState.players) {
        player.stats = { reveals: 0, flags: 0, unflags: 0 };
    }

    // Start new game in database
    if (process.env.ENABLE_DB_LOGGING !== 'false') {
        const game = await db.startGame(CONFIG.gridSize, CONFIG.bombCount);
        if (game) {
            gameState.currentGameId = game.game_id;
            console.log(`🎮 New game started! ID: ${game.game_id} - ${CONFIG.gridSize}x${CONFIG.gridSize} grid with ${CONFIG.bombCount} bombs`);
        }
    } else {
        console.log(`🎮 New game started! ${CONFIG.gridSize}x${CONFIG.gridSize} grid with ${CONFIG.bombCount} bombs`);
    }
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
            // Get the first player who voted for reveal (for attribution)
            const revealer = votes.reveal[0];
            revealCell(x, y, revealer.playerId, revealer.playerName, revealer.playerColor);

            // Increment stats for the player
            const player = gameState.players.get(revealer.playerId);
            if (player) {
                player.stats.reveals++;
            }

            gameState.totalReveals++;
        } else if (winningAction === 'flag' && cell.state === 'hidden') {
            cell.state = 'flagged';
            gameState.flaggedCount++;

            // Increment stats for the first player who voted flag
            const flagger = votes.flag[0];
            const player = gameState.players.get(flagger.playerId);
            if (player) {
                player.stats.flags++;
            }

            gameState.totalFlags++;
        } else if (winningAction === 'unflag' && cell.state === 'flagged') {
            cell.state = 'hidden';
            gameState.flaggedCount--;

            // Increment stats for the first player who voted unflag
            const unflagger = votes.unflag[0];
            const player = gameState.players.get(unflagger.playerId);
            if (player) {
                player.stats.unflags++;
            }

            gameState.totalUnflags++;
        }
    }

    return results;
}

function revealCell(x, y, playerId = null, playerName = null, playerColor = null) {
    const cell = gameState.grid[x][y];
    if (cell.state !== 'hidden') return;

    cell.state = 'revealed';
    gameState.revealedCount++;

    // Track who revealed this cell
    if (playerId && !cell.revealedBy) {
        cell.revealedBy = { playerId, playerName, playerColor };
    }

    if (cell.isBomb) {
        // Game over - reveal all bombs
        gameState.isGameOver = true;
        gameState.isWin = false;

        // Track who caused the game over
        if (playerId) {
            gameState.gameOverPlayer = { playerId, playerName, playerColor };
        }

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
                    // Pass along the revealer info for cascade reveals
                    revealCell(nx, ny, playerId, playerName, playerColor);
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
async function tick() {
    if (gameState.isGameOver) {
        // Clear pending actions but don't process
        gameState.pendingActions = [];
        return;
    }

    gameState.tickNumber++;
    const actionsToProcess = [...gameState.pendingActions];
    gameState.pendingActions = [];
    gameState.lastTickTime = Date.now();

    const wasGameOverBefore = gameState.isGameOver;
    const results = processActions(actionsToProcess);

    // Log all actions to database using BATCH INSERT (much faster!)
    if (process.env.ENABLE_DB_LOGGING !== 'false' && gameState.currentGameId && actionsToProcess.length > 0) {
        const actionLogs = [];

        for (const action of actionsToProcess) {
            const cell = gameState.grid[action.x][action.y];
            const wasExecuted = results.some(r => r.x === action.x && r.y === action.y && r.action === action.type);
            const result = results.find(r => r.x === action.x && r.y === action.y && r.action === action.type);

            let actionResult = 'not_executed';
            if (wasExecuted) {
                if (cell.isBomb && action.type === 'reveal') {
                    actionResult = 'bomb';
                } else if (cell.adjacentBombs === 0 && action.type === 'reveal') {
                    actionResult = 'cascade';
                } else {
                    actionResult = 'safe';
                }
            }

            const player = gameState.players.get(action.playerId);
            const persistentId = player?.persistentId;

            actionLogs.push({
                gameId: gameState.currentGameId,
                playerId: persistentId,
                playerName: action.playerName,
                tickNumber: gameState.tickNumber,
                actionType: action.type,
                x: action.x,
                y: action.y,
                wasExecuted,
                voteCount: result?.votes || 1,
                wasTie: result?.wasTie || false,
                result: actionResult,
                cellHadBomb: cell.isBomb,
                cellAdjacentBombs: cell.adjacentBombs
            });
        }

        // Single batch insert instead of N sequential inserts - MUCH FASTER!
        await db.logActionsBatch(actionLogs);
        gameState.totalActions += actionsToProcess.length;
    }

    // Add results to action history
    const timestamp = Date.now();
    for (const result of results) {
        const cell = gameState.grid[result.x][result.y];
        let actionResult = 'executed';
        if (result.action === 'reveal' && cell.isBomb) {
            actionResult = 'BOMB';
        } else if (result.action === 'reveal' && cell.adjacentBombs === 0) {
            actionResult = 'cascade';
        }

        // Get the first voter for this action for attribution
        const actionsForCell = actionsToProcess.filter(a => a.x === result.x && a.y === result.y && a.type === result.action);
        if (actionsForCell.length > 0) {
            const actor = actionsForCell[0];
            gameState.actionHistory.push({
                timestamp,
                playerId: actor.playerId,
                playerName: actor.playerName,
                playerColor: gameState.players.get(actor.playerId)?.color,
                action: result.action,
                x: result.x,
                y: result.y,
                result: actionResult,
                votes: result.votes,
                wasTie: result.wasTie
            });
        }
    }

    // Keep only last 50 entries
    if (gameState.actionHistory.length > 50) {
        gameState.actionHistory = gameState.actionHistory.slice(-50);
    }

    // Check if game just ended
    if (!wasGameOverBefore && gameState.isGameOver && process.env.ENABLE_DB_LOGGING !== 'false' && gameState.currentGameId) {
        const outcome = gameState.isWin ? 'win' : 'loss';
        const losingPlayerId = gameState.gameOverPlayer?.playerId;
        const losingPlayerName = gameState.gameOverPlayer?.playerName;

        // Get persistent ID if available
        let persistentLosingPlayerId = null;
        if (losingPlayerId) {
            const player = gameState.players.get(losingPlayerId);
            persistentLosingPlayerId = player?.persistentId;
        }

        await db.endGame(
            gameState.currentGameId,
            outcome,
            {
                gameStartTime: gameState.gameStartTime,
                totalActions: gameState.totalActions,
                totalReveals: gameState.totalReveals,
                totalFlags: gameState.totalFlags,
                totalUnflags: gameState.totalUnflags,
                revealedCount: gameState.revealedCount,
                flaggedCount: gameState.flaggedCount
            },
            persistentLosingPlayerId,
            losingPlayerName
        );

        // Update stats for all players who participated
        for (const [socketId, player] of gameState.players) {
            if (player.persistentId) {
                await db.updatePlayerStats(player.persistentId);
            }
        }

        console.log(`🏁 Game ended: ${outcome.toUpperCase()}`);
    }

    // Broadcast tick results
    io.emit('tick', {
        tickNumber: gameState.tickNumber,
        results,
        grid: getPublicGrid(),
        isGameOver: gameState.isGameOver,
        isWin: gameState.isWin,
        stats: getStats(),
        nextTickIn: CONFIG.tickInterval,
        actionHistory: gameState.actionHistory.slice(-15), // Send last 15 for display
        gameOverPlayer: gameState.gameOverPlayer
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
            isBomb: cell.state === 'revealed' ? cell.isBomb : null,
            revealedBy: cell.state === 'revealed' ? cell.revealedBy : null
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

function getPlayerList() {
    const players = [];
    for (const [playerId, player] of gameState.players) {
        players.push({
            id: playerId,
            name: player.name,
            color: player.color,
            stats: player.stats
        });
    }
    return players;
}

// ============== SOCKET HANDLERS ==============
io.on('connection', async (socket) => {
    // Assign player info
    const playerColor = getPlayerColors();
    const playerName = `Player ${gameState.players.size + 1}`;

    // Wait for persistent player ID from client
    socket.once('register', async (data) => {
        const persistentId = data.persistentId;
        const customName = data.playerName || playerName;

        gameState.players.set(socket.id, {
            name: customName,
            color: playerColor,
            stats: { reveals: 0, flags: 0, unflags: 0 },
            persistentId: persistentId
        });

        // Register or update player in database
        if (process.env.ENABLE_DB_LOGGING !== 'false' && persistentId) {
            await db.getOrCreatePlayer(persistentId, customName);

            // Add to current game participants
            if (gameState.currentGameId) {
                await db.addGameParticipant(
                    gameState.currentGameId,
                    persistentId,
                    customName,
                    playerColor
                );
            }
        }

        console.log(`👤 ${customName} connected (${gameState.players.size} total) [${persistentId}]`);

        // Broadcast player joined
        io.emit('playerJoined', {
            playerId: socket.id,
            playerName: customName,
            playerCount: gameState.players.size
        });

        // Debounced player list update (batches rapid joins)
        queuePlayerListUpdate();
    });

    // Send initial state immediately (before registration)
    socket.emit('init', {
        playerId: socket.id,
        playerName,
        playerColor,
        config: CONFIG,
        grid: getPublicGrid(),
        stats: getStats(),
        isGameOver: gameState.isGameOver,
        isWin: gameState.isWin,
        actionHistory: gameState.actionHistory.slice(-15),
        gameOverPlayer: gameState.gameOverPlayer
    });

    // Handle player action
    socket.on('action', (data) => {
        if (gameState.isGameOver) return;

        const { x, y, type } = data;

        // Validate action
        if (x < 0 || x >= CONFIG.gridSize || y < 0 || y >= CONFIG.gridSize) return;
        if (!['reveal', 'flag', 'unflag'].includes(type)) return;

        // Rate limiting - prevent spam
        const now = Date.now();
        const limit = playerVoteLimits.get(socket.id) || { count: 0, resetTime: now + CONFIG.tickInterval };

        // Reset counter every tick interval
        if (now > limit.resetTime) {
            limit.count = 0;
            limit.resetTime = now + CONFIG.tickInterval;
        }

        // Allow only 1 vote per tick - strategic decision making!
        if (limit.count >= MAX_VOTES_PER_TICK) {
            // Don't log warning for single vote limit - this is expected behavior
            socket.emit('voteLimitReached', {
                message: 'You can only vote once per tick. Choose wisely!',
                nextTickIn: limit.resetTime - now
            });
            return;
        }

        limit.count++;
        playerVoteLimits.set(socket.id, limit);

        // Prevent memory overflow
        if (gameState.pendingActions.length > 10000) {
            console.error('⚠️ Pending actions overflow! Clearing oldest...');
            gameState.pendingActions = gameState.pendingActions.slice(-5000);
        }

        // Queue the action
        gameState.pendingActions.push({
            playerId: socket.id,
            playerName: gameState.players.get(socket.id)?.name,
            x,
            y,
            type,
            timestamp: Date.now()
        });

        // REMOVED: actionQueued broadcast
        // With 1000 users, broadcasting every action = 500,000 messages per tick
        // Instead, clients can show their own pending actions locally
    });

    // Handle reset request
    socket.on('resetGame', () => {
        resetGame();
        io.emit('gameReset', {
            grid: getPublicGrid(),
            stats: getStats()
        });
    });

    // Handle player name change
    socket.on('setPlayerName', async (newName) => {
        const player = gameState.players.get(socket.id);
        if (!player) return;

        // Validate name
        const trimmedName = String(newName).trim();
        if (!trimmedName || trimmedName.length === 0) return;
        if (trimmedName.length > 20) return;

        const oldName = player.name;
        player.name = trimmedName;

        // Update in database
        if (process.env.ENABLE_DB_LOGGING !== 'false' && player.persistentId) {
            await db.getOrCreatePlayer(player.persistentId, trimmedName);
        }

        console.log(`👤 ${oldName} changed name to ${trimmedName}`);

        // Debounced player list update
        queuePlayerListUpdate();
    });

    // Handle disconnect
    socket.on('disconnect', async () => {
        const player = gameState.players.get(socket.id);

        // Clean up rate limit tracking
        playerVoteLimits.delete(socket.id);

        // Remove pending actions from this player
        gameState.pendingActions = gameState.pendingActions.filter(
            a => a.playerId !== socket.id
        );

        // Remove from game participants in database
        if (process.env.ENABLE_DB_LOGGING !== 'false' && player?.persistentId && gameState.currentGameId) {
            await db.removeGameParticipant(gameState.currentGameId, player.persistentId);
        }

        gameState.players.delete(socket.id);
        console.log(`👤 ${player?.name || 'Unknown'} disconnected (${gameState.players.size} remaining)`);

        io.emit('playerLeft', {
            playerId: socket.id,
            playerName: player?.name,
            playerCount: gameState.players.size
        });

        // Debounced player list update
        queuePlayerListUpdate();
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

// Analytics endpoints
app.get('/api/stats/player/:playerId', async (req, res) => {
    try {
        const stats = await db.getPlayerStats(req.params.playerId);
        if (stats) {
            res.json(stats);
        } else {
            res.status(404).json({ error: 'Player not found' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/stats/global', async (req, res) => {
    try {
        const stats = await db.getGlobalStats();
        res.json(stats || {});
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/leaderboard/:type?', async (req, res) => {
    try {
        const type = req.params.type || 'wins';
        const limit = parseInt(req.query.limit) || 10;
        const leaderboard = await db.getLeaderboard(type, limit);
        res.json(leaderboard);
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/games/recent', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const games = await db.getRecentGames(limit);
        res.json(games);
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============== START SERVER ==============
resetGame(); // Initialize first game

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`🎮 Mines Swept server running on port ${PORT}`);
    console.log(`⏰ Tick interval: ${CONFIG.tickInterval}ms`);
    console.log(`📐 Grid: ${CONFIG.gridSize}x${CONFIG.gridSize} with ${CONFIG.bombCount} bombs`);
});
