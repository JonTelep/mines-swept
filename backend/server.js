// server.js
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

const config = {
    gridSize: 100,
    bombCount: 1000
};

let gameState = generateGameState(config.gridSize, config.bombCount);

function generateGameState(gridSize, bombCount) {
    const grid = Array.from({ length: gridSize }, () =>
        Array.from({ length: gridSize }, () => ({
            isRevealed: false,
            isBomb: false,
            adjacentBombs: 0
        }))
    );

    // Place bombs randomly
    let bombsPlaced = 0;
    while (bombsPlaced < bombCount) {
        const x = Math.floor(Math.random() * gridSize);
        const y = Math.floor(Math.random() * gridSize);
        if (!grid[x][y].isBomb) {
            grid[x][y].isBomb = true;
            bombsPlaced++;
        }
    }

    // Calculate adjacent bombs
    for (let x = 0; x < gridSize; x++) {
        for (let y = 0; y < gridSize; y++) {
            if (!grid[x][y].isBomb) {
                let count = 0;
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx >= 0 && nx < gridSize && ny >= 0 && ny < gridSize && grid[nx][ny].isBomb) {
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

io.on('connection', (socket) => {
    console.log('a user connected');
    socket.emit('gameState', gameState);

    socket.on('clickTile', (x, y) => {
        if (gameState[x][y].isRevealed) return;

        gameState[x][y].isRevealed = true;
        if (gameState[x][y].isBomb) {
            io.emit('gameOver');
        } else {
            io.emit('updateTile', { x, y, tile: gameState[x][y] });
        }
    });

    socket.on('resetGame', () => {
        gameState = generateGameState(config.gridSize, config.bombCount);
        io.emit('gameState', gameState);
    });
});

server.listen(3000, () => {
    console.log('listening on *:3000');
});