// App.js - Tick-based Multiplayer Minesweeper Client
import React, { useEffect, useState, useCallback } from 'react';
import io from 'socket.io-client';
import './App.css';

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || 'http://localhost:3000';

function App() {
  const [socket, setSocket] = useState(null);
  const [grid, setGrid] = useState([]);
  const [stats, setStats] = useState(null);
  const [config, setConfig] = useState(null);
  const [playerInfo, setPlayerInfo] = useState(null);
  const [isGameOver, setIsGameOver] = useState(false);
  const [isWin, setIsWin] = useState(false);
  const [pendingActions, setPendingActions] = useState([]);
  const [tickResults, setTickResults] = useState([]);
  const [timeToTick, setTimeToTick] = useState(3000);
  const [playerCount, setPlayerCount] = useState(0);

  // Connect to server
  useEffect(() => {
    const newSocket = io(SOCKET_URL);
    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, []);

  // Socket event handlers
  useEffect(() => {
    if (!socket) return;

    socket.on('init', (data) => {
      console.log('🎮 Game initialized:', data);
      setGrid(data.grid);
      setStats(data.stats);
      setConfig(data.config);
      setPlayerInfo({
        id: data.playerId,
        name: data.playerName,
        color: data.playerColor
      });
      setIsGameOver(data.isGameOver);
      setIsWin(data.isWin);
      setPlayerCount(data.stats.playerCount);
    });

    socket.on('tick', (data) => {
      console.log(`⏰ Tick #${data.tickNumber}:`, data.results);
      setGrid(data.grid);
      setStats(data.stats);
      setIsGameOver(data.isGameOver);
      setIsWin(data.isWin);
      setTickResults(data.results);
      setPendingActions([]);
      setTimeToTick(data.nextTickIn);
    });

    socket.on('actionQueued', (data) => {
      setPendingActions(prev => [...prev, data]);
    });

    socket.on('playerJoined', (data) => {
      setPlayerCount(data.playerCount);
    });

    socket.on('playerLeft', (data) => {
      setPlayerCount(data.playerCount);
    });

    socket.on('gameReset', (data) => {
      setGrid(data.grid);
      setStats(data.stats);
      setIsGameOver(false);
      setIsWin(false);
      setPendingActions([]);
      setTickResults([]);
    });

    return () => {
      socket.off('init');
      socket.off('tick');
      socket.off('actionQueued');
      socket.off('playerJoined');
      socket.off('playerLeft');
      socket.off('gameReset');
    };
  }, [socket]);

  // Countdown timer
  useEffect(() => {
    const interval = setInterval(() => {
      setTimeToTick(prev => Math.max(0, prev - 100));
    }, 100);
    return () => clearInterval(interval);
  }, []);

  // Handle cell click
  const handleCellClick = useCallback((x, y, e) => {
    if (!socket || isGameOver) return;

    const cell = grid[x]?.[y];
    if (!cell || cell.state === 'revealed') return;

    let actionType;
    if (e.shiftKey || e.ctrlKey || e.button === 2) {
      // Right click or shift+click = toggle flag
      actionType = cell.state === 'flagged' ? 'unflag' : 'flag';
    } else {
      // Left click = reveal
      actionType = 'reveal';
    }

    socket.emit('action', { x, y, type: actionType });
  }, [socket, grid, isGameOver]);

  // Handle reset
  const handleReset = useCallback(() => {
    if (socket) {
      socket.emit('resetGame');
    }
  }, [socket]);

  // Prevent context menu
  const handleContextMenu = useCallback((e) => {
    e.preventDefault();
  }, []);

  // Get pending actions for a cell
  const getPendingForCell = (x, y) => {
    return pendingActions.filter(a => a.x === x && a.y === y);
  };

  // Render cell
  const renderCell = (cell) => {
    const { x, y, state, adjacentBombs, isBomb } = cell;
    const cellPending = getPendingForCell(x, y);

    let content = '';
    let className = 'cell';

    if (state === 'revealed') {
      className += ' revealed';
      if (isBomb) {
        content = '💣';
        className += ' bomb';
      } else if (adjacentBombs > 0) {
        content = adjacentBombs;
        className += ` num-${adjacentBombs}`;
      }
    } else if (state === 'flagged') {
      content = '🚩';
      className += ' flagged';
    }

    // Show pending actions
    if (cellPending.length > 0) {
      className += ' has-pending';
    }

    return (
      <div
        key={`${x}-${y}`}
        className={className}
        onClick={(e) => handleCellClick(x, y, e)}
        onContextMenu={(e) => {
          e.preventDefault();
          handleCellClick(x, y, { ...e, shiftKey: true });
        }}
      >
        {content}
        {cellPending.length > 0 && (
          <div className="pending-indicator">
            {cellPending.map((p, i) => (
              <span
                key={i}
                className={`pending-dot ${p.type}`}
                style={{ backgroundColor: p.playerColor }}
                title={`${p.playerName}: ${p.type}`}
              />
            ))}
          </div>
        )}
      </div>
    );
  };

  if (!grid.length) {
    return <div className="loading">Connecting to server...</div>;
  }

  return (
    <div className="app" onContextMenu={handleContextMenu}>
      <header className="header">
        <h1>💣 Mines Swept</h1>
        <p className="subtitle">A Social Experiment in Collaborative Minesweeper</p>
      </header>

      <div className="game-container">
        {/* Stats Panel */}
        <div className="stats-panel">
          <div className="stat">
            <span className="stat-label">Players Online</span>
            <span className="stat-value">{playerCount}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Next Tick</span>
            <span className="stat-value countdown">{(timeToTick / 1000).toFixed(1)}s</span>
          </div>
          <div className="stat">
            <span className="stat-label">Tick #</span>
            <span className="stat-value">{stats?.tickNumber || 0}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Pending Actions</span>
            <span className="stat-value">{pendingActions.length}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Revealed</span>
            <span className="stat-value">{stats?.revealedCount || 0}/{(stats?.totalCells || 0) - (stats?.bombCount || 0)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Flags</span>
            <span className="stat-value">{stats?.flaggedCount || 0}/{stats?.bombCount || 0}</span>
          </div>
        </div>

        {/* Game Board */}
        <div className="board-container">
          {isGameOver && (
            <div className={`game-over-overlay ${isWin ? 'win' : 'lose'}`}>
              <div className="game-over-content">
                <h2>{isWin ? '🎉 Victory!' : '💥 Game Over!'}</h2>
                <p>{isWin ? 'The collective succeeded!' : 'A bomb was revealed!'}</p>
                <button onClick={handleReset} className="reset-btn">
                  Start New Game
                </button>
              </div>
            </div>
          )}

          <div
            className="board"
            style={{
              gridTemplateColumns: `repeat(${config?.gridSize || 10}, 1fr)`
            }}
          >
            {grid.flat().map(cell => renderCell(cell))}
          </div>
        </div>

        {/* Player Info */}
        <div className="player-info">
          <div className="player-badge" style={{ borderColor: playerInfo?.color }}>
            <span className="player-color" style={{ backgroundColor: playerInfo?.color }}></span>
            <span className="player-name">{playerInfo?.name}</span>
          </div>
        </div>

        {/* Instructions */}
        <div className="instructions">
          <h3>How to Play</h3>
          <ul>
            <li><strong>Left Click:</strong> Vote to reveal a cell</li>
            <li><strong>Right Click / Shift+Click:</strong> Vote to flag/unflag</li>
            <li><strong>Every 3 seconds:</strong> All votes are counted</li>
            <li><strong>Majority wins:</strong> Ties are resolved by coin flip</li>
          </ul>
        </div>

        {/* Last Tick Results */}
        {tickResults.length > 0 && (
          <div className="tick-results">
            <h4>Last Tick Results:</h4>
            <ul>
              {tickResults.map((r, i) => (
                <li key={i}>
                  [{r.x},{r.y}]: {r.action} ({r.votes} votes)
                  {r.wasTie && <span className="tie-badge">🎲 Tie resolved</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
