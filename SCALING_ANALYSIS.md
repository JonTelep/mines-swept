# Scaling Analysis - Mines Swept to 1000+ Concurrent Users

## Current Performance Profile

### Expected Load at 1000 Users
- **Actions per tick**: ~300-500 votes (not all users vote every tick)
- **Ticks per minute**: 20 (every 3 seconds)
- **Database writes per minute**: 6,000-10,000 action logs
- **Socket messages per minute**: 20,000-40,000 (20 ticks × 1000 users × 1-2 messages each)
- **Bandwidth per user**: ~5-10 KB/s (mostly small JSON messages)

## Critical Issues & Solutions

### 🔴 CRITICAL: Database Write Performance

**Current Problem:**
```javascript
// In tick() function - SEQUENTIAL awaits
for (const action of actionsToProcess) {
    await db.logAction(...);  // ❌ Blocking, slow with 500 actions
}
```

With 500 actions per tick, this is 500 sequential database calls every 3 seconds = **~166 writes/second**.

**Solution: Batch Inserts**
```javascript
// MUCH FASTER - Single bulk insert
async function logActionsBatch(actions) {
    if (actions.length === 0) return;

    const values = actions.map(a =>
        `('${a.gameId}', '${a.playerId}', '${a.playerName}', ${a.tickNumber}, '${a.actionType}', ${a.x}, ${a.y}, ${a.wasExecuted}, ${a.voteCount}, ${a.wasTie}, '${a.result}', ${a.cellHadBomb}, ${a.cellAdjacentBombs})`
    ).join(',');

    await pool.query(`
        INSERT INTO actions (game_id, player_id, player_name, tick_number, action_type, cell_x, cell_y, was_executed, vote_count, was_tie, result, cell_had_bomb, cell_adjacent_bombs)
        VALUES ${values}
    `);
}
```

**Performance Impact:**
- Before: 500 queries × 5ms = 2,500ms (blocks tick for 2.5 seconds!)
- After: 1 query × 10ms = 10ms
- **250x faster** ⚡

---

### 🔴 CRITICAL: Broadcasting Overhead

**Current Problem:**
```javascript
io.emit('tick', { ...hugePayload });  // ❌ Sends to ALL 1000 users
io.emit('playerListUpdate', ...);     // ❌ Every join/leave = 1000 messages
io.emit('actionQueued', ...);          // ❌ Every vote = 1000 messages
```

At 1000 users:
- Each `io.emit()` = 1000 individual socket messages
- 500 votes queued = 500,000 messages sent
- **Huge bandwidth and CPU cost**

**Solution: Optimize Broadcasts**
```javascript
// 1. Debounce player list updates
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

// 2. Don't broadcast every queued action
// Remove this entirely - clients can show "pending" locally
// socket.on('actionQueued', ...) - DELETE THIS

// 3. Compress tick payload
io.emit('tick', {
    t: gameState.tickNumber,  // Shorter keys
    r: results.map(r => [r.x, r.y, r.action, r.votes]), // Array format
    // ... send only diffs, not full grid
});
```

**Performance Impact:**
- Before: 500 actionQueued × 1000 users = 500,000 messages
- After: 0 actionQueued messages
- **Massive bandwidth savings**

---

### 🟡 IMPORTANT: Rate Limiting

**Current Problem:**
```javascript
socket.on('action', (data) => {
    // ❌ No rate limiting - user can spam 1000s of votes
    gameState.pendingActions.push(...);
});
```

A malicious/buggy client could spam votes and:
- Fill up pendingActions array
- Cause memory issues
- Skew voting results

**Solution: Rate Limiting**
```javascript
// Add to player state
const playerVoteLimits = new Map(); // socketId -> { count, resetTime }

socket.on('action', (data) => {
    const now = Date.now();
    const limit = playerVoteLimits.get(socket.id) || { count: 0, resetTime: now + 3000 };

    // Reset counter every tick interval
    if (now > limit.resetTime) {
        limit.count = 0;
        limit.resetTime = now + CONFIG.tickInterval;
    }

    // Allow max 5 votes per tick (prevents spam but allows flag + reveal + changes)
    if (limit.count >= 5) {
        console.warn(`⚠️ Rate limit exceeded for ${socket.id}`);
        return;
    }

    limit.count++;
    playerVoteLimits.set(socket.id, limit);

    // Process action...
});
```

---

### 🟡 IMPORTANT: Memory Management

**Current Problem:**
```javascript
gameState.actionHistory = []; // ❌ Grows unbounded in long games
gameState.pendingActions = []; // ❌ Could grow large if tick fails
```

**Solution: Bounds and Cleanup**
```javascript
// Already have this for actionHistory (max 50) ✅

// Add for pendingActions
if (gameState.pendingActions.length > 10000) {
    console.error('⚠️ Pending actions overflow! Clearing...');
    gameState.pendingActions = gameState.pendingActions.slice(-5000);
}

// Add cleanup on disconnect
socket.on('disconnect', () => {
    // Remove pending actions from this player
    gameState.pendingActions = gameState.pendingActions.filter(
        a => a.playerId !== socket.id
    );
});
```

---

### 🟢 NICE TO HAVE: Multiple Game Rooms

**Current State:**
One global game state - all users play same game.

**Enhancement: Room Support**
```javascript
// Multiple concurrent games
const games = new Map(); // roomId -> gameState

io.on('connection', (socket) => {
    socket.on('joinRoom', (roomId) => {
        socket.join(roomId);
        let game = games.get(roomId);
        if (!game) {
            game = createNewGame(roomId);
            games.set(roomId, game);
        }
        // ...
    });

    socket.on('action', (data) => {
        const roomId = [...socket.rooms][1]; // First room after default
        const game = games.get(roomId);
        // Process action for this specific game
    });
});
```

**Benefits:**
- Multiple difficulty levels (easy/medium/hard)
- Private games for groups
- Segmentation reduces individual game size
- 10 rooms × 100 users each = better than 1 room × 1000 users

---

### 🟢 NICE TO HAVE: Horizontal Scaling

**Current State:**
Single Node.js process - vertical scaling only.

**Enhancement: Redis + Multiple Instances**
```javascript
// Using Socket.io Redis adapter
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');

const pubClient = createClient({ host: 'localhost', port: 6379 });
const subClient = pubClient.duplicate();

io.adapter(createAdapter(pubClient, subClient));
```

Then run multiple instances behind nginx:
```nginx
upstream mineswept {
    server localhost:3001;
    server localhost:3002;
    server localhost:3003;
    server localhost:3004;
}

server {
    listen 80;
    location / {
        proxy_pass http://mineswept;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

**Performance Impact:**
- 4 instances × 250 users each = 1000 users
- Better CPU utilization
- Fault tolerance

---

## Performance Optimizations Summary

### Immediate (Do Before Launch)

1. **✅ Batch Database Writes** (250x faster)
   - Implement `logActionsBatch()` in db.js
   - Update `tick()` to use bulk insert

2. **✅ Remove actionQueued Broadcasts** (500,000 fewer messages)
   - Delete `io.emit('actionQueued')`
   - Handle pending state client-side

3. **✅ Add Rate Limiting** (prevent spam)
   - Max 5 votes per tick per player
   - Prevents abuse

4. **✅ Debounce Player List Updates** (10x fewer broadcasts)
   - Batch updates every 500ms

### Short Term (First Week)

5. **✅ Add Monitoring**
   - Track tick processing time
   - Monitor database connection pool
   - Alert on high memory usage

6. **✅ Optimize Grid Broadcasts**
   - Send only cell diffs, not full grid
   - Compress repeated data

7. **✅ Database Indexes** (already have most)
   - Verify all queries use indexes
   - Add composite indexes if needed

### Medium Term (First Month)

8. **✅ Implement Game Rooms**
   - Multiple concurrent games
   - Better segmentation

9. **✅ Add Caching**
   - Redis for leaderboards
   - Cache player stats (update on game end)

10. **✅ Load Testing**
    - Simulate 1000 concurrent users
    - Identify bottlenecks

### Long Term (As Needed)

11. **✅ Horizontal Scaling**
    - Redis adapter for Socket.io
    - Multiple server instances
    - Load balancer

12. **✅ CDN for Frontend**
    - Serve static assets from CDN
    - Reduce server load

## Estimated Performance

### Current Implementation (No Changes)
- **Max Users**: ~100-200 before slowdown
- **Bottleneck**: Sequential DB writes + broadcast spam
- **Tick Processing**: 2-5 seconds with 500 actions

### With Immediate Fixes
- **Max Users**: ~500-1000
- **Bottleneck**: Socket.io message throughput
- **Tick Processing**: <100ms with 500 actions

### With All Optimizations
- **Max Users**: 5,000-10,000+
- **Bottleneck**: Database write throughput
- **Tick Processing**: <50ms with 500 actions

## Load Testing Plan

```bash
# Install Artillery for load testing
npm install -g artillery

# Create test scenario
cat > load-test.yml <<EOF
config:
  target: "http://localhost:3001"
  phases:
    - duration: 60
      arrivalRate: 10  # 10 new users per second
      name: "Ramp up"
    - duration: 300
      arrivalRate: 0   # Hold at 600 users
      name: "Sustained load"
  socketio:
    transports: ["websocket"]

scenarios:
  - name: "Play Game"
    engine: socketio
    flow:
      - emit:
          channel: "register"
          data:
            persistentId: "{{ $uuid }}"
            playerName: "LoadTest{{ $uuid }}"
      - think: 3
      - loop:
        - emit:
            channel: "action"
            data:
              x: "{{ $randomNumber(0, 9) }}"
              y: "{{ $randomNumber(0, 9) }}"
              type: "reveal"
        - think: 5
        count: 20
EOF

# Run test
artillery run load-test.yml
```

## Monitoring Checklist

- [ ] Response times (p50, p95, p99)
- [ ] Database connection pool utilization
- [ ] Memory usage per user
- [ ] Socket.io message queue length
- [ ] Tick processing time
- [ ] Error rates
- [ ] Active connections count

## Cost Estimates (1000 Users)

### Server (Single Instance)
- **CPU**: 2-4 cores (Node.js single-threaded + DB)
- **RAM**: 4-8 GB (mostly for connections)
- **Bandwidth**: ~50-100 Mbps sustained
- **Cost**: ~$40-80/month (DigitalOcean, Linode)

### Database
- **PostgreSQL**: Shared with app server
- **Storage**: ~1 GB/day with 1000 active users
- **Cost**: Included in server

### Total
- **Single server**: $40-80/month for 1000 concurrent users
- **With scaling**: $100-200/month for 5000+ users

## Conclusion

### Current State: B+ (Good, needs tuning)

**Strengths:**
- ✅ Tick-based architecture is excellent for scale
- ✅ Vote batching naturally handles concurrency
- ✅ PostgreSQL can handle the load
- ✅ Analytics design is solid

**Weaknesses:**
- ❌ Sequential database writes will bottleneck
- ❌ Broadcast spam wastes bandwidth
- ❌ No rate limiting
- ❌ Not tested under load

### After Immediate Fixes: A (Production Ready)

With just 4 changes (batch writes, remove actionQueued, rate limiting, debounce updates), you'll easily handle 1000 concurrent users on a single $80/month server.

### Recommendation

**Do this before launch:**
1. Implement batch database writes (1 hour)
2. Remove actionQueued broadcasts (15 min)
3. Add rate limiting (30 min)
4. Debounce player list updates (15 min)
5. Load test with Artillery (1 hour)

**Total time to production-ready: ~3 hours of work**

The architecture is fundamentally sound. You just need to eliminate the inefficiencies before scaling up. The tick-based voting system is actually BRILLIANT for handling thousands of users - it naturally batches and rate-limits in a way that makes sense for the gameplay.

This is a really well-designed social experiment platform! 🎮
