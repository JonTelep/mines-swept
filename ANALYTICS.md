# Mines Swept Analytics Guide

This document explains the analytics system and how to use the data.

## 🎯 What's Being Tracked

### Individual Player Metrics

Each player gets a persistent UUID stored in their browser's localStorage. This allows tracking across sessions while maintaining privacy (no login required).

**Actions Tracked:**
- ✅ **Every vote cast** - Even votes that don't win are logged
- ✅ **Executed actions** - Actions that actually happened (won the vote)
- ✅ **Reveal outcomes** - Safe cells, bombs, cascades
- ✅ **Flag accuracy** - Valid flags (on bombs) vs invalid flags (on safe cells)

**Statistics Calculated:**
- Games played / won / lost
- Total reveals and their safety rate
- Flag accuracy percentage
- Vote success rate (how often your votes win)
- Games where you caused the loss (hit a bomb)
- First bloods (first action in a game)

### Game Metrics

Each game is tracked with:
- Start and end timestamps
- Duration
- Outcome (win/loss/abandoned)
- Total players
- Total actions taken
- Grid configuration (size, bomb count)
- Who caused a loss (if applicable)

### Global Statistics

Aggregated across all players:
- Total games played
- Win/loss ratio
- Total unique players
- Average game duration
- Average actions per game
- Records (longest game, most players, etc.)

## 📊 API Endpoints

All endpoints return JSON data.

### Get Player Stats
```bash
GET /api/stats/player/:playerId

# Example
curl http://localhost:3001/api/stats/player/550e8400-e29b-41d4-a716-446655440000
```

Response:
```json
{
  "player_id": "550e8400-e29b-41d4-a716-446655440000",
  "player_name": "Alice",
  "total_games_played": 42,
  "total_games_won": 28,
  "total_games_lost": 14,
  "total_reveals": 156,
  "safe_reveals": 150,
  "bomb_reveals": 6,
  "reveal_accuracy_percent": 96.15,
  "total_flags_placed": 45,
  "valid_flags": 38,
  "invalid_flags": 7,
  "flag_accuracy_percent": 84.44,
  "vote_success_rate": 67.50
}
```

### Get Global Stats
```bash
GET /api/stats/global

curl http://localhost:3001/api/stats/global
```

### Get Leaderboards
```bash
GET /api/leaderboard/:type?limit=10

# Types: wins, accuracy, flags
curl http://localhost:3001/api/leaderboard/wins?limit=10
curl http://localhost:3001/api/leaderboard/accuracy?limit=10
curl http://localhost:3001/api/leaderboard/flags?limit=10
```

### Get Recent Games
```bash
GET /api/games/recent?limit=20

curl http://localhost:3001/api/games/recent?limit=20
```

## 🔍 Example Queries

### Find Your Player ID

Your player ID is stored in localStorage. Open browser console:

```javascript
localStorage.getItem('mineswept_playerId')
```

### Most Active Players
```sql
SELECT p.player_name, ps.total_games_played, ps.total_votes_cast
FROM player_stats ps
JOIN players p ON ps.player_id = p.player_id
ORDER BY ps.total_games_played DESC
LIMIT 10;
```

### Best Accuracy (min 20 reveals)
```sql
SELECT p.player_name,
       ps.reveal_accuracy_percent,
       ps.total_reveals,
       ps.safe_reveals
FROM player_stats ps
JOIN players p ON ps.player_id = p.player_id
WHERE ps.total_reveals >= 20
ORDER BY ps.reveal_accuracy_percent DESC
LIMIT 10;
```

### Riskiest Players (most bomb reveals)
```sql
SELECT p.player_name,
       ps.bomb_reveals,
       ps.total_reveals,
       ps.games_caused_loss
FROM player_stats ps
JOIN players p ON ps.player_id = p.player_id
WHERE ps.bomb_reveals > 0
ORDER BY ps.bomb_reveals DESC
LIMIT 10;
```

### Game Duration Analysis
```sql
SELECT
    AVG(duration_seconds) as avg_duration,
    MIN(duration_seconds) as fastest,
    MAX(duration_seconds) as longest,
    COUNT(*) as total_games
FROM games
WHERE ended_at IS NOT NULL
GROUP BY outcome;
```

### Action Heatmap (most clicked cells)
```sql
SELECT cell_x, cell_y, COUNT(*) as action_count
FROM actions
WHERE was_executed = TRUE
GROUP BY cell_x, cell_y
ORDER BY action_count DESC
LIMIT 20;
```

### Hourly Activity Pattern
```sql
SELECT
    EXTRACT(HOUR FROM timestamp) as hour_of_day,
    COUNT(*) as action_count,
    COUNT(DISTINCT player_id) as unique_players
FROM actions
GROUP BY hour_of_day
ORDER BY hour_of_day;
```

### Player Collaboration Network
```sql
-- Players who played together most often
SELECT
    gp1.player_name as player1,
    gp2.player_name as player2,
    COUNT(*) as games_together
FROM game_participants gp1
JOIN game_participants gp2 ON gp1.game_id = gp2.game_id
WHERE gp1.player_id < gp2.player_id
GROUP BY gp1.player_id, gp2.player_id, gp1.player_name, gp2.player_name
ORDER BY games_together DESC
LIMIT 20;
```

## 📈 Interesting Metrics to Track

### Risk vs Reward
```sql
SELECT
    p.player_name,
    ps.reveal_accuracy_percent,
    ps.total_reveals,
    ps.total_games_won::FLOAT / NULLIF(ps.total_games_played, 0) * 100 as win_rate
FROM player_stats ps
JOIN players p ON ps.player_id = p.player_id
WHERE ps.total_games_played >= 5
ORDER BY win_rate DESC, reveal_accuracy_percent DESC;
```

### Flag Masters
```sql
SELECT
    p.player_name,
    ps.valid_flags,
    ps.flag_accuracy_percent,
    ps.total_games_won
FROM player_stats ps
JOIN players p ON ps.player_id = p.player_id
WHERE ps.total_flags_placed >= 10
ORDER BY ps.flag_accuracy_percent DESC, ps.valid_flags DESC;
```

### Voting Influence
```sql
-- Players whose votes most often win
SELECT
    p.player_name,
    ps.total_votes_cast,
    ps.total_winning_votes,
    ps.vote_success_rate
FROM player_stats ps
JOIN players p ON ps.player_id = p.player_id
WHERE ps.total_votes_cast >= 20
ORDER BY ps.vote_success_rate DESC;
```

## 🎮 Social Experiment Insights

### Collective Decision Making
- Do more players lead to better decisions?
- Is there a "wisdom of crowds" effect?
- How do voting ties affect outcomes?

```sql
SELECT
    total_players,
    AVG(duration_seconds) as avg_duration,
    COUNT(*) FILTER (WHERE outcome = 'win') as wins,
    COUNT(*) FILTER (WHERE outcome = 'loss') as losses,
    COUNT(*) FILTER (WHERE outcome = 'win')::FLOAT / COUNT(*) * 100 as win_rate
FROM games
WHERE ended_at IS NOT NULL
GROUP BY total_players
ORDER BY total_players;
```

### Action Patterns
- Do players get more conservative as game progresses?
- What's the ratio of reveals to flags?

```sql
SELECT
    tick_number / 10 * 10 as tick_range,
    COUNT(*) FILTER (WHERE action_type = 'reveal') as reveals,
    COUNT(*) FILTER (WHERE action_type = 'flag') as flags,
    COUNT(*) FILTER (WHERE action_type = 'unflag') as unflags
FROM actions
WHERE was_executed = TRUE
GROUP BY tick_range
ORDER BY tick_range;
```

### Learning Curve
- Do players improve over time?

```sql
WITH player_games AS (
    SELECT
        gp.player_id,
        p.player_name,
        g.game_id,
        g.started_at,
        g.outcome,
        ROW_NUMBER() OVER (PARTITION BY gp.player_id ORDER BY g.started_at) as game_number
    FROM game_participants gp
    JOIN games g ON gp.game_id = g.game_id
    JOIN players p ON gp.player_id = p.player_id
    WHERE g.ended_at IS NOT NULL
)
SELECT
    CASE
        WHEN game_number BETWEEN 1 AND 10 THEN '1-10'
        WHEN game_number BETWEEN 11 AND 20 THEN '11-20'
        WHEN game_number BETWEEN 21 AND 50 THEN '21-50'
        ELSE '50+'
    END as experience_level,
    COUNT(*) FILTER (WHERE outcome = 'win') as wins,
    COUNT(*) as total_games,
    COUNT(*) FILTER (WHERE outcome = 'win')::FLOAT / COUNT(*) * 100 as win_rate
FROM player_games
GROUP BY experience_level
ORDER BY MIN(game_number);
```

## 💡 Tips

1. **Export Data**: Use `pg_dump` or connect with tools like Metabase, Grafana, or Superset
2. **Real-time Analytics**: Query the database while games are running
3. **Data Science**: Export to CSV for analysis in Python/R
4. **Visualizations**: Build dashboards with your favorite tools

## 🔒 Privacy

- Player IDs are UUID v4 (random, not tied to any personal info)
- No IP addresses are stored
- No personal data collected
- Players can clear their localStorage to get a new ID
- All data is local to your database

## 📝 Notes

- Stats update after each game ends
- Granular action logs allow retroactive analysis
- Consider data retention policies for production
- Database can grow large with many games (plan accordingly)
