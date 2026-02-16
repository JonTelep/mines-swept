// App.js - Tick-based Multiplayer Minesweeper Client
import React, { useEffect, useState, useCallback } from 'react';
import io from 'socket.io-client';
import './App.css';

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || 'http://localhost:3001';

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
  const [allPlayers, setAllPlayers] = useState([]);
  const [actionHistory, setActionHistory] = useState([]);
  const [showNameDialog, setShowNameDialog] = useState(true);
  const [customName, setCustomName] = useState('');
  const [gameOverPlayer, setGameOverPlayer] = useState(null);

  // Generate or get persistent player ID
  const getPersistentPlayerId = () => {
    let playerId = localStorage.getItem('mineswept_playerId');
    if (!playerId) {
      // Generate UUID v4
      playerId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
      localStorage.setItem('mineswept_playerId', playerId);
    }
    return playerId;
  };

  // Load saved name from localStorage
  useEffect(() => {
    const savedName = localStorage.getItem('mineswept_playerName');
    if (savedName) {
      setCustomName(savedName);
    }
  }, []);

  // Connect to server
  useEffect(() => {
    const newSocket = io(SOCKET_URL);
    setSocket(newSocket);

    // Register with persistent ID once connected
    newSocket.on('connect', () => {
      const persistentId = getPersistentPlayerId();
      const savedName = localStorage.getItem('mineswept_playerName');
      newSocket.emit('register', {
        persistentId,
        playerName: savedName
      });
    });

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
      setActionHistory(data.actionHistory || []);
      setGameOverPlayer(data.gameOverPlayer);
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
      setActionHistory(data.actionHistory || []);
      setGameOverPlayer(data.gameOverPlayer);
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

    socket.on('playerListUpdate', (players) => {
      setAllPlayers(players);
    });

    socket.on('gameReset', (data) => {
      setGrid(data.grid);
      setStats(data.stats);
      setIsGameOver(false);
      setIsWin(false);
      setPendingActions([]);
      setTickResults([]);
      setGameOverPlayer(null);
    });

    return () => {
      socket.off('init');
      socket.off('tick');
      socket.off('actionQueued');
      socket.off('playerJoined');
      socket.off('playerLeft');
      socket.off('playerListUpdate');
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

  // Handle name submission
  const handleNameSubmit = useCallback(() => {
    const trimmedName = customName.trim();
    if (!trimmedName || !socket) return;

    // Save to localStorage
    localStorage.setItem('mineswept_playerName', trimmedName);

    // Send to server
    socket.emit('setPlayerName', trimmedName);

    // Update local player info
    setPlayerInfo(prev => ({ ...prev, name: trimmedName }));

    // Hide dialog
    setShowNameDialog(false);
  }, [customName, socket]);

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
    const { x, y, state, adjacentBombs, isBomb, revealedBy } = cell;
    const cellPending = getPendingForCell(x, y);

    let content = '';
    let className = 'cell';
    let title = '';

    if (state === 'revealed') {
      className += ' revealed';
      if (isBomb) {
        content = '💣';
        className += ' bomb';
      } else if (adjacentBombs > 0) {
        content = adjacentBombs;
        className += ` num-${adjacentBombs}`;
      }

      // Add attribution tooltip
      if (revealedBy) {
        title = `Revealed by ${revealedBy.playerName}`;
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
        title={title}
      >
        {content}
        {revealedBy && state === 'revealed' && (
          <div
            className="cell-attribution-badge"
            style={{ backgroundColor: revealedBy.playerColor }}
          />
        )}
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
      {/* Name Dialog */}
      {showNameDialog && (
        <div className="name-dialog-overlay" onClick={() => customName.trim() && handleNameSubmit()}>
          <div className="name-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Join the Game</h2>
            <p>Enter your name to start playing</p>
            <input
              type="text"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleNameSubmit()}
              placeholder="Enter your name..."
              maxLength={20}
              autoFocus
            />
            <button onClick={handleNameSubmit} disabled={!customName.trim()}>
              Join Game
            </button>
          </div>
        </div>
      )}

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
                {isWin ? (
                  <p>The collective succeeded!</p>
                ) : (
                  <>
                    <p>A bomb was revealed!</p>
                    {gameOverPlayer && (
                      <p className="game-over-player">
                        <span
                          className="game-over-player-color"
                          style={{ backgroundColor: gameOverPlayer.playerColor }}
                        />
                        <strong>{gameOverPlayer.playerName}</strong> hit the bomb
                      </p>
                    )}
                  </>
                )}
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

        {/* Player List Panel */}
        <div className="player-list-panel">
          <h3>Players ({allPlayers.length})</h3>
          <div className="player-list">
            {allPlayers.map((player) => (
              <div
                key={player.id}
                className={`player-list-item ${player.id === playerInfo?.id ? 'current-player' : ''}`}
              >
                <span
                  className="player-color-dot"
                  style={{ backgroundColor: player.color }}
                />
                <span className="player-list-name">{player.name}</span>
                <span className="player-stats">
                  {player.stats.reveals}R / {player.stats.flags}F
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Action History Panel */}
        <div className="action-history-panel">
          <h3>Recent Actions</h3>
          <div className="action-history">
            {actionHistory.slice().reverse().map((action, i) => {
              const timeAgo = ((Date.now() - action.timestamp) / 1000).toFixed(1);
              let emoji = '';
              if (action.action === 'reveal') emoji = '👁️';
              else if (action.action === 'flag') emoji = '🚩';
              else if (action.action === 'unflag') emoji = '❌';

              let resultText = '';
              if (action.result === 'BOMB') resultText = ' 💣 BOMB!';
              else if (action.result === 'cascade') resultText = ' ⚡ cascade';

              return (
                <div key={`${action.timestamp}-${i}`} className="action-history-item">
                  <span
                    className="action-player-color"
                    style={{ backgroundColor: action.playerColor }}
                  />
                  <span className="action-text">
                    <strong>{action.playerName}</strong> {emoji} ({action.x},{action.y})
                    {resultText}
                    {action.wasTie && ' 🎲'}
                  </span>
                  <span className="action-time">{timeAgo}s ago</span>
                </div>
              );
            })}
            {actionHistory.length === 0 && (
              <div className="no-actions">No actions yet</div>
            )}
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
