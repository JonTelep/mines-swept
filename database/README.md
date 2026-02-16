# Mines Swept Database Setup

This directory contains the PostgreSQL database schema for the Mines Swept analytics system.

## Prerequisites

- PostgreSQL 12 or higher
- Access to create databases and extensions

## Quick Setup

### 1. Install PostgreSQL

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install postgresql postgresql-contrib
```

**macOS (Homebrew):**
```bash
brew install postgresql
brew services start postgresql
```

**Arch Linux:**
```bash
sudo pacman -S postgresql
sudo systemctl enable postgresql
sudo systemctl start postgresql
```

### 2. Create Database

```bash
# Switch to postgres user
sudo -u postgres psql

# In psql:
CREATE DATABASE mineswept;
CREATE USER mineswept_user WITH PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE mineswept TO mineswept_user;
\q
```

### 3. Run Schema

```bash
# Run the schema file
psql -U mineswept_user -d mineswept -f schema.sql

# Or as postgres user:
sudo -u postgres psql -d mineswept -f schema.sql
```

### 4. Configure Backend

Copy the example environment file and update with your database credentials:

```bash
cd ../backend
cp .env.example .env
```

Edit `.env`:
```
DB_HOST=localhost
DB_PORT=5432
DB_NAME=mineswept
DB_USER=mineswept_user
DB_PASSWORD=your_secure_password
ENABLE_DB_LOGGING=true
```

### 5. Test Connection

Start the backend server:
```bash
cd ../backend
npm run dev
```

You should see: `📊 Database connected`

## Database Structure

### Tables

- **players** - Persistent player records with UUID
- **games** - Individual game instances
- **game_participants** - Links players to games they played
- **actions** - Granular log of every action/vote
- **player_stats** - Aggregated statistics per player
- **global_stats** - Overall system statistics
- **daily_stats** - Daily aggregates for trend analysis

### Key Metrics Tracked

**Per Player:**
- Total games played/won/lost
- Reveal accuracy (safe vs bomb reveals)
- Flag accuracy (valid vs invalid flags)
- Vote success rate
- First blood count (first action in game)

**Global:**
- Total games, wins, losses
- Total actions, reveals, flags
- Average game duration
- Player participation metrics
- Records (longest game, most players, etc.)

## API Endpoints

Once the backend is running, you can access stats via:

- `GET /api/stats/player/:playerId` - Individual player stats
- `GET /api/stats/global` - Global statistics
- `GET /api/leaderboard/:type` - Leaderboards (wins, accuracy, flags)
- `GET /api/games/recent` - Recent game history

## Useful Queries

### Top 10 Players by Wins
```sql
SELECT p.player_name, ps.total_games_won, ps.total_games_played,
       ps.reveal_accuracy_percent
FROM player_stats ps
JOIN players p ON ps.player_id = p.player_id
ORDER BY ps.total_games_won DESC
LIMIT 10;
```

### Top 10 Players by Accuracy
```sql
SELECT p.player_name, ps.reveal_accuracy_percent,
       ps.total_reveals, ps.safe_reveals
FROM player_stats ps
JOIN players p ON ps.player_id = p.player_id
WHERE ps.total_reveals >= 10
ORDER BY ps.reveal_accuracy_percent DESC
LIMIT 10;
```

### Recent Games
```sql
SELECT game_id, started_at, ended_at, outcome,
       total_players, total_actions, duration_seconds
FROM games
WHERE ended_at IS NOT NULL
ORDER BY ended_at DESC
LIMIT 20;
```

### Daily Activity
```sql
SELECT stat_date, games_played, unique_players, win_rate
FROM daily_stats
ORDER BY stat_date DESC
LIMIT 30;
```

## Maintenance

### Update Stats Manually

If stats get out of sync, you can manually update them:

```sql
-- Update specific player stats
SELECT update_player_stats('player-uuid-here');

-- Update global stats
SELECT update_global_stats();

-- Update today's daily stats
SELECT update_daily_stats(CURRENT_DATE);
```

### Backup Database

```bash
pg_dump -U mineswept_user mineswept > backup_$(date +%Y%m%d).sql
```

### Restore Database

```bash
psql -U mineswept_user mineswept < backup_20260215.sql
```

### Clean Old Data (Optional)

To remove granular action logs older than 90 days but keep aggregated stats:

```sql
DELETE FROM actions WHERE timestamp < NOW() - INTERVAL '90 days';
```

## Troubleshooting

### Connection Issues

If you see "database connection failed":
1. Check PostgreSQL is running: `sudo systemctl status postgresql`
2. Verify credentials in `.env` file
3. Check PostgreSQL allows connections from your host in `pg_hba.conf`

### Permission Errors

```sql
-- Grant all permissions to user
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO mineswept_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO mineswept_user;
```

### Performance Issues

Add additional indexes if queries are slow:
```sql
CREATE INDEX idx_actions_executed ON actions(was_executed);
CREATE INDEX idx_games_players ON games(total_players);
```

## Development

To disable database logging during development:

```bash
# In .env
ENABLE_DB_LOGGING=false
```

This allows the game to run without a database connection.
