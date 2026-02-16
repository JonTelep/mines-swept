-- ============================================
-- Mines Swept Analytics Database Schema
-- ============================================
-- PostgreSQL 12+
-- Social experiment analytics and player tracking
-- ============================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================
-- TABLES
-- ============================================

-- Players table - persistent player records
CREATE TABLE IF NOT EXISTS players (
    player_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_name VARCHAR(100),
    first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    total_sessions INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Games table - each game instance
CREATE TABLE IF NOT EXISTS games (
    game_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP,
    duration_seconds INTEGER,
    outcome VARCHAR(20), -- 'win', 'loss', 'abandoned'
    grid_size INTEGER,
    bomb_count INTEGER,
    total_players INTEGER,
    total_actions INTEGER DEFAULT 0,
    total_reveals INTEGER DEFAULT 0,
    total_flags INTEGER DEFAULT 0,
    total_unflags INTEGER DEFAULT 0,
    final_revealed_count INTEGER,
    final_flagged_count INTEGER,
    losing_player_id UUID REFERENCES players(player_id),
    losing_player_name VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Game participants - who played in which games
CREATE TABLE IF NOT EXISTS game_participants (
    id SERIAL PRIMARY KEY,
    game_id UUID REFERENCES games(game_id) ON DELETE CASCADE,
    player_id UUID REFERENCES players(player_id),
    player_name VARCHAR(100),
    player_color VARCHAR(20),
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    left_at TIMESTAMP,
    session_duration_seconds INTEGER
);

-- Actions table - granular action log
CREATE TABLE IF NOT EXISTS actions (
    action_id BIGSERIAL PRIMARY KEY,
    game_id UUID REFERENCES games(game_id) ON DELETE CASCADE,
    player_id UUID REFERENCES players(player_id),
    player_name VARCHAR(100),
    tick_number INTEGER,
    action_type VARCHAR(20), -- 'reveal', 'flag', 'unflag'
    cell_x INTEGER,
    cell_y INTEGER,
    was_executed BOOLEAN DEFAULT FALSE, -- did this vote win
    vote_count INTEGER,
    was_tie BOOLEAN DEFAULT FALSE,
    result VARCHAR(20), -- 'safe', 'bomb', 'cascade', 'already_revealed', etc.
    cell_had_bomb BOOLEAN,
    cell_adjacent_bombs INTEGER,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Player statistics - aggregated per player
CREATE TABLE IF NOT EXISTS player_stats (
    player_id UUID PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,

    -- Game participation
    total_games_played INTEGER DEFAULT 0,
    total_games_won INTEGER DEFAULT 0,
    total_games_lost INTEGER DEFAULT 0,

    -- Vote statistics
    total_votes_cast INTEGER DEFAULT 0,
    total_winning_votes INTEGER DEFAULT 0,

    -- Reveal statistics
    total_reveals INTEGER DEFAULT 0,
    safe_reveals INTEGER DEFAULT 0, -- revealed a safe cell
    bomb_reveals INTEGER DEFAULT 0, -- revealed a bomb (caused loss)
    cascade_reveals INTEGER DEFAULT 0, -- revealed cell with 0 adjacent

    -- Flag statistics
    total_flags_placed INTEGER DEFAULT 0,
    valid_flags INTEGER DEFAULT 0, -- flags on actual bombs
    invalid_flags INTEGER DEFAULT 0, -- flags on safe cells
    total_unflags INTEGER DEFAULT 0,

    -- Accuracy metrics
    reveal_accuracy_percent DECIMAL(5,2), -- % of reveals that were safe
    flag_accuracy_percent DECIMAL(5,2), -- % of flags that were valid
    vote_success_rate DECIMAL(5,2), -- % of votes that won

    -- Achievements
    first_bloods INTEGER DEFAULT 0, -- first action in a game
    games_caused_loss INTEGER DEFAULT 0, -- hit a bomb

    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Global statistics - aggregated across all players
CREATE TABLE IF NOT EXISTS global_stats (
    id INTEGER PRIMARY KEY DEFAULT 1,

    -- Game statistics
    total_games_played INTEGER DEFAULT 0,
    total_games_won INTEGER DEFAULT 0,
    total_games_lost INTEGER DEFAULT 0,
    total_games_abandoned INTEGER DEFAULT 0,

    -- Player statistics
    total_unique_players INTEGER DEFAULT 0,
    total_sessions INTEGER DEFAULT 0,

    -- Action statistics
    total_actions INTEGER DEFAULT 0,
    total_reveals INTEGER DEFAULT 0,
    total_flags INTEGER DEFAULT 0,
    total_unflags INTEGER DEFAULT 0,
    total_safe_reveals INTEGER DEFAULT 0,
    total_bomb_reveals INTEGER DEFAULT 0,
    total_valid_flags INTEGER DEFAULT 0,
    total_invalid_flags INTEGER DEFAULT 0,

    -- Averages
    avg_game_duration_seconds INTEGER,
    avg_players_per_game DECIMAL(5,2),
    avg_actions_per_game DECIMAL(5,2),

    -- Records
    longest_game_seconds INTEGER,
    shortest_win_seconds INTEGER,
    most_players_in_game INTEGER,
    most_actions_in_game INTEGER,

    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT single_row CHECK (id = 1)
);

-- Daily statistics for trend analysis
CREATE TABLE IF NOT EXISTS daily_stats (
    stat_date DATE PRIMARY KEY,
    games_played INTEGER DEFAULT 0,
    unique_players INTEGER DEFAULT 0,
    total_actions INTEGER DEFAULT 0,
    games_won INTEGER DEFAULT 0,
    games_lost INTEGER DEFAULT 0,
    win_rate DECIMAL(5,2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX IF NOT EXISTS idx_games_outcome ON games(outcome);
CREATE INDEX IF NOT EXISTS idx_games_started_at ON games(started_at);
CREATE INDEX IF NOT EXISTS idx_games_ended_at ON games(ended_at);
CREATE INDEX IF NOT EXISTS idx_actions_game_id ON actions(game_id);
CREATE INDEX IF NOT EXISTS idx_actions_player_id ON actions(player_id);
CREATE INDEX IF NOT EXISTS idx_actions_timestamp ON actions(timestamp);
CREATE INDEX IF NOT EXISTS idx_actions_type ON actions(action_type);
CREATE INDEX IF NOT EXISTS idx_game_participants_game_id ON game_participants(game_id);
CREATE INDEX IF NOT EXISTS idx_game_participants_player_id ON game_participants(player_id);
CREATE INDEX IF NOT EXISTS idx_players_last_seen ON players(last_seen_at);

-- ============================================
-- FUNCTIONS
-- ============================================

-- Function to update player stats (called after each game)
CREATE OR REPLACE FUNCTION update_player_stats(p_player_id UUID)
RETURNS VOID AS $$
BEGIN
    -- Ensure player_stats record exists
    INSERT INTO player_stats (player_id) VALUES (p_player_id)
    ON CONFLICT (player_id) DO NOTHING;

    -- Update all stats
    UPDATE player_stats SET
        total_votes_cast = (SELECT COUNT(*) FROM actions WHERE player_id = p_player_id),
        total_winning_votes = (SELECT COUNT(*) FROM actions WHERE player_id = p_player_id AND was_executed = TRUE),
        total_reveals = (SELECT COUNT(*) FROM actions WHERE player_id = p_player_id AND action_type = 'reveal' AND was_executed = TRUE),
        safe_reveals = (SELECT COUNT(*) FROM actions WHERE player_id = p_player_id AND action_type = 'reveal' AND was_executed = TRUE AND result IN ('safe', 'cascade')),
        bomb_reveals = (SELECT COUNT(*) FROM actions WHERE player_id = p_player_id AND action_type = 'reveal' AND was_executed = TRUE AND result = 'bomb'),
        cascade_reveals = (SELECT COUNT(*) FROM actions WHERE player_id = p_player_id AND action_type = 'reveal' AND was_executed = TRUE AND result = 'cascade'),
        total_flags_placed = (SELECT COUNT(*) FROM actions WHERE player_id = p_player_id AND action_type = 'flag' AND was_executed = TRUE),
        valid_flags = (SELECT COUNT(*) FROM actions WHERE player_id = p_player_id AND action_type = 'flag' AND was_executed = TRUE AND cell_had_bomb = TRUE),
        invalid_flags = (SELECT COUNT(*) FROM actions WHERE player_id = p_player_id AND action_type = 'flag' AND was_executed = TRUE AND cell_had_bomb = FALSE),
        total_unflags = (SELECT COUNT(*) FROM actions WHERE player_id = p_player_id AND action_type = 'unflag' AND was_executed = TRUE),
        total_games_played = (SELECT COUNT(DISTINCT game_id) FROM game_participants WHERE player_id = p_player_id),
        total_games_won = (SELECT COUNT(DISTINCT gp.game_id) FROM game_participants gp JOIN games g ON gp.game_id = g.game_id WHERE gp.player_id = p_player_id AND g.outcome = 'win'),
        total_games_lost = (SELECT COUNT(DISTINCT gp.game_id) FROM game_participants gp JOIN games g ON gp.game_id = g.game_id WHERE gp.player_id = p_player_id AND g.outcome = 'loss'),
        games_caused_loss = (SELECT COUNT(*) FROM games WHERE losing_player_id = p_player_id),
        updated_at = CURRENT_TIMESTAMP
    WHERE player_id = p_player_id;

    -- Update accuracy percentages
    UPDATE player_stats SET
        reveal_accuracy_percent = CASE WHEN total_reveals > 0 THEN (safe_reveals::DECIMAL / total_reveals * 100) ELSE 0 END,
        flag_accuracy_percent = CASE WHEN total_flags_placed > 0 THEN (valid_flags::DECIMAL / total_flags_placed * 100) ELSE 0 END,
        vote_success_rate = CASE WHEN total_votes_cast > 0 THEN (total_winning_votes::DECIMAL / total_votes_cast * 100) ELSE 0 END
    WHERE player_id = p_player_id;
END;
$$ LANGUAGE plpgsql;

-- Function to update global stats
CREATE OR REPLACE FUNCTION update_global_stats()
RETURNS VOID AS $$
BEGIN
    UPDATE global_stats SET
        total_games_played = (SELECT COUNT(*) FROM games WHERE ended_at IS NOT NULL),
        total_games_won = (SELECT COUNT(*) FROM games WHERE outcome = 'win'),
        total_games_lost = (SELECT COUNT(*) FROM games WHERE outcome = 'loss'),
        total_games_abandoned = (SELECT COUNT(*) FROM games WHERE outcome = 'abandoned'),
        total_unique_players = (SELECT COUNT(*) FROM players),
        total_sessions = (SELECT SUM(total_sessions) FROM players),
        total_actions = (SELECT COUNT(*) FROM actions),
        total_reveals = (SELECT COUNT(*) FROM actions WHERE action_type = 'reveal' AND was_executed = TRUE),
        total_flags = (SELECT COUNT(*) FROM actions WHERE action_type = 'flag' AND was_executed = TRUE),
        total_unflags = (SELECT COUNT(*) FROM actions WHERE action_type = 'unflag' AND was_executed = TRUE),
        total_safe_reveals = (SELECT COUNT(*) FROM actions WHERE action_type = 'reveal' AND was_executed = TRUE AND result IN ('safe', 'cascade')),
        total_bomb_reveals = (SELECT COUNT(*) FROM actions WHERE action_type = 'reveal' AND was_executed = TRUE AND result = 'bomb'),
        total_valid_flags = (SELECT COUNT(*) FROM actions WHERE action_type = 'flag' AND was_executed = TRUE AND cell_had_bomb = TRUE),
        total_invalid_flags = (SELECT COUNT(*) FROM actions WHERE action_type = 'flag' AND was_executed = TRUE AND cell_had_bomb = FALSE),
        avg_game_duration_seconds = (SELECT AVG(duration_seconds)::INTEGER FROM games WHERE ended_at IS NOT NULL),
        avg_players_per_game = (SELECT AVG(total_players) FROM games WHERE ended_at IS NOT NULL),
        avg_actions_per_game = (SELECT AVG(total_actions) FROM games WHERE ended_at IS NOT NULL),
        longest_game_seconds = (SELECT MAX(duration_seconds) FROM games WHERE ended_at IS NOT NULL),
        shortest_win_seconds = (SELECT MIN(duration_seconds) FROM games WHERE outcome = 'win'),
        most_players_in_game = (SELECT MAX(total_players) FROM games),
        most_actions_in_game = (SELECT MAX(total_actions) FROM games),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = 1;
END;
$$ LANGUAGE plpgsql;

-- Function to update daily stats
CREATE OR REPLACE FUNCTION update_daily_stats(stat_date DATE)
RETURNS VOID AS $$
BEGIN
    INSERT INTO daily_stats (stat_date, games_played, unique_players, total_actions, games_won, games_lost)
    SELECT
        stat_date,
        COUNT(DISTINCT g.game_id),
        COUNT(DISTINCT gp.player_id),
        COUNT(a.action_id),
        COUNT(DISTINCT CASE WHEN g.outcome = 'win' THEN g.game_id END),
        COUNT(DISTINCT CASE WHEN g.outcome = 'loss' THEN g.game_id END)
    FROM games g
    LEFT JOIN game_participants gp ON g.game_id = gp.game_id
    LEFT JOIN actions a ON g.game_id = a.game_id
    WHERE DATE(g.started_at) = stat_date
    ON CONFLICT (stat_date) DO UPDATE SET
        games_played = EXCLUDED.games_played,
        unique_players = EXCLUDED.unique_players,
        total_actions = EXCLUDED.total_actions,
        games_won = EXCLUDED.games_won,
        games_lost = EXCLUDED.games_lost,
        win_rate = CASE
            WHEN EXCLUDED.games_played > 0
            THEN (EXCLUDED.games_won::DECIMAL / EXCLUDED.games_played * 100)
            ELSE 0
        END;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- INITIALIZATION
-- ============================================

-- Initialize global stats with single row
INSERT INTO global_stats (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ============================================
-- USEFUL QUERIES
-- ============================================

-- Top players by wins
-- SELECT p.player_name, ps.total_games_won, ps.total_games_played, ps.reveal_accuracy_percent
-- FROM player_stats ps
-- JOIN players p ON ps.player_id = p.player_id
-- ORDER BY ps.total_games_won DESC
-- LIMIT 10;

-- Top players by accuracy
-- SELECT p.player_name, ps.reveal_accuracy_percent, ps.flag_accuracy_percent, ps.total_reveals, ps.total_flags_placed
-- FROM player_stats ps
-- JOIN players p ON ps.player_id = p.player_id
-- WHERE ps.total_reveals >= 10
-- ORDER BY ps.reveal_accuracy_percent DESC
-- LIMIT 10;

-- Recent games
-- SELECT game_id, started_at, ended_at, outcome, total_players, total_actions, duration_seconds
-- FROM games
-- WHERE ended_at IS NOT NULL
-- ORDER BY ended_at DESC
-- LIMIT 20;

-- Player game history
-- SELECT g.game_id, g.started_at, g.outcome, g.total_players, g.duration_seconds
-- FROM games g
-- JOIN game_participants gp ON g.game_id = gp.game_id
-- WHERE gp.player_id = 'YOUR-PLAYER-UUID-HERE'
-- ORDER BY g.started_at DESC;

-- Daily trends
-- SELECT stat_date, games_played, unique_players, win_rate
-- FROM daily_stats
-- ORDER BY stat_date DESC
-- LIMIT 30;
