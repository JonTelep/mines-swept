# 🚀 Quick Start Guide - Analytics System

## First Time Setup (5 minutes)

### 1. Install PostgreSQL (if not already installed)

**Arch Linux:**
```bash
sudo pacman -S postgresql
sudo systemctl enable --now postgresql
```

**Ubuntu/Debian:**
```bash
sudo apt install postgresql postgresql-contrib
```

**macOS:**
```bash
brew install postgresql
brew services start postgresql
```

### 2. Run Automated Setup

```bash
cd database
./setup.sh
```

This will:
- Create database and user
- Run schema
- Create `.env` file with credentials

### 3. Start the Application

```bash
# Terminal 1 - Backend
cd backend
npm install  # if you haven't already
npm run dev

# Terminal 2 - Frontend
cd frontend
npm install  # if you haven't already
npm start
```

### 4. Verify It Works

**In backend terminal, look for:**
```
📊 Database connected
🎮 New game started! ID: <some-uuid>
```

**Test API:**
```bash
curl http://localhost:3001/api/stats/global
```

You should see JSON with global statistics!

## Already Set Up?

### Start Services
```bash
# Terminal 1
cd backend && npm run dev

# Terminal 2
cd frontend && npm start
```

### Check Stats
```bash
# Global stats
curl http://localhost:3001/api/stats/global | jq

# Leaderboard
curl http://localhost:3001/api/leaderboard/wins | jq

# Recent games
curl http://localhost:3001/api/games/recent | jq
```

### Get Your Player ID

Open browser console (F12) and run:
```javascript
localStorage.getItem('mineswept_playerId')
```

Then check your stats:
```bash
curl http://localhost:3001/api/stats/player/YOUR-UUID-HERE | jq
```

## Useful Database Queries

### Connect to Database
```bash
psql -U mineswept_user -d mineswept
```

### Top 10 Players by Wins
```sql
SELECT p.player_name, ps.total_games_won, ps.total_games_played,
       ROUND(ps.reveal_accuracy_percent, 2) as accuracy
FROM player_stats ps
JOIN players p ON ps.player_id = p.player_id
ORDER BY ps.total_games_won DESC
LIMIT 10;
```

### Win Rate by Player Count
```sql
SELECT total_players,
       COUNT(*) as games,
       COUNT(*) FILTER (WHERE outcome = 'win') as wins,
       ROUND(COUNT(*) FILTER (WHERE outcome = 'win')::NUMERIC / COUNT(*) * 100, 2) as win_rate
FROM games
WHERE ended_at IS NOT NULL
GROUP BY total_players
ORDER BY total_players;
```

### Your Recent Games
```sql
-- Replace YOUR-UUID with your player ID
SELECT g.game_id, g.started_at, g.outcome, g.duration_seconds, g.total_players
FROM games g
JOIN game_participants gp ON g.game_id = gp.game_id
WHERE gp.player_id = 'YOUR-UUID'
ORDER BY g.started_at DESC
LIMIT 10;
```

## API Endpoints Quick Reference

| Endpoint | Description | Example |
|----------|-------------|---------|
| `/api/stats/global` | Overall statistics | `curl localhost:3001/api/stats/global` |
| `/api/stats/player/:id` | Individual player stats | `curl localhost:3001/api/stats/player/<uuid>` |
| `/api/leaderboard/wins` | Top players by wins | `curl localhost:3001/api/leaderboard/wins` |
| `/api/leaderboard/accuracy` | Top players by accuracy | `curl localhost:3001/api/leaderboard/accuracy` |
| `/api/leaderboard/flags` | Top flag placers | `curl localhost:3001/api/leaderboard/flags` |
| `/api/games/recent` | Recent game history | `curl localhost:3001/api/games/recent?limit=20` |

## Environment Variables

Edit `backend/.env`:

```bash
# Server
PORT=3001

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=mineswept
DB_USER=mineswept_user
DB_PASSWORD=your_password

# Enable/disable database logging
ENABLE_DB_LOGGING=true  # Set to false to run without database
```

## Troubleshooting

### Database won't connect
```bash
# Check PostgreSQL is running
sudo systemctl status postgresql

# Start it if not running
sudo systemctl start postgresql

# Test connection manually
psql -U mineswept_user -d mineswept -c "SELECT 1;"
```

### Permission errors
```bash
sudo -u postgres psql
GRANT ALL PRIVILEGES ON DATABASE mineswept TO mineswept_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO mineswept_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO mineswept_user;
```

### Reset everything
```bash
# Drop and recreate database
sudo -u postgres psql
DROP DATABASE mineswept;
\q

# Run setup again
cd database && ./setup.sh
```

### Run without database
```bash
# In backend/.env
ENABLE_DB_LOGGING=false

# Now backend will run without database
cd backend && npm run dev
```

## Data Export

### Backup database
```bash
pg_dump -U mineswept_user mineswept > backup_$(date +%Y%m%d).sql
```

### Export stats to CSV
```bash
psql -U mineswept_user -d mineswept -c "\COPY player_stats TO 'player_stats.csv' CSV HEADER"
psql -U mineswept_user -d mineswept -c "\COPY games TO 'games.csv' CSV HEADER"
```

### Export for analysis
```python
# Python with pandas
import pandas as pd
import psycopg2

conn = psycopg2.connect(
    host="localhost",
    database="mineswept",
    user="mineswept_user",
    password="your_password"
)

df = pd.read_sql("SELECT * FROM player_stats", conn)
df.to_csv('stats_export.csv')
```

## Next Steps

1. ✅ **Play some games** - Generate data to analyze
2. ✅ **Check the leaderboard** - See who's winning
3. ✅ **Explore the data** - Run custom queries
4. ✅ **Build visualizations** - Connect to Grafana/Metabase
5. ✅ **Share results** - Publish your findings!

## More Information

- **Full setup guide**: `database/README.md`
- **Analytics guide**: `ANALYTICS.md`
- **Implementation details**: `IMPLEMENTATION_SUMMARY.md`

## Support

If something's not working:
1. Check the troubleshooting section above
2. Verify all environment variables are set
3. Check PostgreSQL logs: `sudo journalctl -u postgresql -n 50`
4. Review backend console output for errors

Happy analyzing! 🎮📊
