// App.js
import React, { useEffect, useState } from 'react';
import io from 'socket.io-client';

const socket = io('http://localhost:3000');

function App() {
  const [grid, setGrid] = useState([]);
  const [gameOver, setGameOver] = useState(false);

  useEffect(() => {
    socket.on('gameState', (newGrid) => {
      setGrid(newGrid);
      setGameOver(false);
    });

    socket.on('updateTile', ({ x, y, tile }) => {
      setGrid((prevGrid) => {
        const newGrid = [...prevGrid];
        newGrid[x][y] = tile;
        return newGrid;
      });
    });

    socket.on('gameOver', () => {
      setGameOver(true);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  const handleClick = (x, y) => {
    if (!gameOver) {
      socket.emit('clickTile', x, y);
    }
  };

  const handleReset = () => {
    socket.emit('resetGame');
  };

  return (
    <div>
      <button onClick={handleReset}>Reset Game</button>
      {gameOver && <div>Game Over!</div>}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${grid.length}, 20px)` }}>
        {grid.map((row, x) =>
          row.map((tile, y) => (
            <div
              key={`${x}-${y}`}
              style={{
                width: 20,
                height: 20,
                border: '1px solid black',
                backgroundColor: tile.isRevealed ? '#ccc' : '#666',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer'
              }}
              onClick={() => handleClick(x, y)}
            >
              {tile.isRevealed && (tile.isBomb ? '💣' : tile.adjacentBombs > 0 ? tile.adjacentBombs : '')}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default App;