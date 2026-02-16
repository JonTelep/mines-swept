// db.js - PostgreSQL Database Connection and Helper Functions
const { Pool } = require('pg');

// Create connection pool
const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'mineswept',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    max: 20, // Maximum number of clients in the pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Test connection on startup
pool.on('connect', () => {
    console.log('📊 Database connected');
});

pool.on('error', (err) => {
    console.error('💥 Unexpected database error:', err);
});

// ============================================
// DATABASE HELPER FUNCTIONS
// ============================================

/**
 * Get or create a player by their persistent ID
 */
async function getOrCreatePlayer(playerId, playerName) {
    try {
        // Try to get existing player
        let result = await pool.query(
            'SELECT * FROM players WHERE player_id = $1',
            [playerId]
        );

        if (result.rows.length > 0) {
            // Update last seen and name if changed
            await pool.query(
                `UPDATE players
                SET last_seen_at = CURRENT_TIMESTAMP,
                    player_name = $2,
                    total_sessions = total_sessions + 1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE player_id = $1`,
                [playerId, playerName]
            );
            return result.rows[0];
        } else {
            // Create new player
            result = await pool.query(
                `INSERT INTO players (player_id, player_name, total_sessions)
                VALUES ($1, $2, 1)
                RETURNING *`,
                [playerId, playerName]
            );
            return result.rows[0];
        }
    } catch (error) {
        console.error('Error in getOrCreatePlayer:', error);
        return null;
    }
}

/**
 * Start a new game
 */
async function startGame(gridSize, bombCount) {
    try {
        const result = await pool.query(
            `INSERT INTO games (grid_size, bomb_count, total_players)
            VALUES ($1, $2, 0)
            RETURNING game_id, started_at`,
            [gridSize, bombCount]
        );
        return result.rows[0];
    } catch (error) {
        console.error('Error in startGame:', error);
        return null;
    }
}

/**
 * End a game
 */
async function endGame(gameId, outcome, stats, losingPlayerId = null, losingPlayerName = null) {
    try {
        const duration = Math.floor((Date.now() - stats.gameStartTime) / 1000);

        await pool.query(
            `UPDATE games SET
                ended_at = CURRENT_TIMESTAMP,
                duration_seconds = $2,
                outcome = $3,
                total_actions = $4,
                total_reveals = $5,
                total_flags = $6,
                total_unflags = $7,
                final_revealed_count = $8,
                final_flagged_count = $9,
                losing_player_id = $10,
                losing_player_name = $11
            WHERE game_id = $1`,
            [
                gameId,
                duration,
                outcome,
                stats.totalActions,
                stats.totalReveals,
                stats.totalFlags,
                stats.totalUnflags,
                stats.revealedCount,
                stats.flaggedCount,
                losingPlayerId,
                losingPlayerName
            ]
        );

        // Update global stats
        await pool.query('SELECT update_global_stats()');

        // Update daily stats
        await pool.query('SELECT update_daily_stats(CURRENT_DATE)');

    } catch (error) {
        console.error('Error in endGame:', error);
    }
}

/**
 * Add a player to a game
 */
async function addGameParticipant(gameId, playerId, playerName, playerColor) {
    try {
        await pool.query(
            `INSERT INTO game_participants (game_id, player_id, player_name, player_color)
            VALUES ($1, $2, $3, $4)`,
            [gameId, playerId, playerName, playerColor]
        );

        // Update total players count
        await pool.query(
            `UPDATE games SET total_players = (
                SELECT COUNT(DISTINCT player_id) FROM game_participants WHERE game_id = $1
            ) WHERE game_id = $1`,
            [gameId]
        );
    } catch (error) {
        console.error('Error in addGameParticipant:', error);
    }
}

/**
 * Remove a player from a game (on disconnect)
 */
async function removeGameParticipant(gameId, playerId) {
    try {
        const result = await pool.query(
            `SELECT joined_at FROM game_participants
            WHERE game_id = $1 AND player_id = $2 AND left_at IS NULL`,
            [gameId, playerId]
        );

        if (result.rows.length > 0) {
            const joinedAt = new Date(result.rows[0].joined_at);
            const duration = Math.floor((Date.now() - joinedAt) / 1000);

            await pool.query(
                `UPDATE game_participants
                SET left_at = CURRENT_TIMESTAMP, session_duration_seconds = $3
                WHERE game_id = $1 AND player_id = $2`,
                [gameId, playerId, duration]
            );
        }
    } catch (error) {
        console.error('Error in removeGameParticipant:', error);
    }
}

/**
 * Log an action (vote)
 */
async function logAction(gameId, playerId, playerName, tickNumber, actionType, x, y, wasExecuted = false, voteCount = 1, wasTie = false, result = null, cellHadBomb = null, cellAdjacentBombs = null) {
    try {
        await pool.query(
            `INSERT INTO actions (
                game_id, player_id, player_name, tick_number, action_type,
                cell_x, cell_y, was_executed, vote_count, was_tie,
                result, cell_had_bomb, cell_adjacent_bombs
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [
                gameId, playerId, playerName, tickNumber, actionType,
                x, y, wasExecuted, voteCount, wasTie,
                result, cellHadBomb, cellAdjacentBombs
            ]
        );
    } catch (error) {
        console.error('Error in logAction:', error);
    }
}

/**
 * Update player stats after a game
 */
async function updatePlayerStats(playerId) {
    try {
        await pool.query('SELECT update_player_stats($1)', [playerId]);
    } catch (error) {
        console.error('Error in updatePlayerStats:', error);
    }
}

/**
 * Get player stats
 */
async function getPlayerStats(playerId) {
    try {
        const result = await pool.query(
            `SELECT ps.*, p.player_name, p.first_seen_at, p.last_seen_at
            FROM player_stats ps
            JOIN players p ON ps.player_id = p.player_id
            WHERE ps.player_id = $1`,
            [playerId]
        );
        return result.rows[0] || null;
    } catch (error) {
        console.error('Error in getPlayerStats:', error);
        return null;
    }
}

/**
 * Get global stats
 */
async function getGlobalStats() {
    try {
        const result = await pool.query('SELECT * FROM global_stats WHERE id = 1');
        return result.rows[0] || null;
    } catch (error) {
        console.error('Error in getGlobalStats:', error);
        return null;
    }
}

/**
 * Get leaderboard
 */
async function getLeaderboard(type = 'wins', limit = 10) {
    try {
        let orderBy;
        switch (type) {
            case 'wins':
                orderBy = 'ps.total_games_won DESC';
                break;
            case 'accuracy':
                orderBy = 'ps.reveal_accuracy_percent DESC';
                break;
            case 'flags':
                orderBy = 'ps.valid_flags DESC';
                break;
            default:
                orderBy = 'ps.total_games_won DESC';
        }

        const result = await pool.query(
            `SELECT
                p.player_id, p.player_name,
                ps.total_games_played, ps.total_games_won, ps.total_games_lost,
                ps.reveal_accuracy_percent, ps.flag_accuracy_percent,
                ps.total_reveals, ps.valid_flags
            FROM player_stats ps
            JOIN players p ON ps.player_id = p.player_id
            WHERE ps.total_games_played > 0
            ORDER BY ${orderBy}
            LIMIT $1`,
            [limit]
        );
        return result.rows;
    } catch (error) {
        console.error('Error in getLeaderboard:', error);
        return [];
    }
}

/**
 * Get recent games
 */
async function getRecentGames(limit = 20) {
    try {
        const result = await pool.query(
            `SELECT
                game_id, started_at, ended_at, outcome,
                total_players, total_actions, duration_seconds,
                losing_player_name
            FROM games
            WHERE ended_at IS NOT NULL
            ORDER BY ended_at DESC
            LIMIT $1`,
            [limit]
        );
        return result.rows;
    } catch (error) {
        console.error('Error in getRecentGames:', error);
        return [];
    }
}

module.exports = {
    pool,
    getOrCreatePlayer,
    startGame,
    endGame,
    addGameParticipant,
    removeGameParticipant,
    logAction,
    updatePlayerStats,
    getPlayerStats,
    getGlobalStats,
    getLeaderboard,
    getRecentGames,
};
