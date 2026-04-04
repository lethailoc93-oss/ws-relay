// ================================================
// WebSocket Relay Server v2.0 — Optimized Cloud Deploy
// Routes messages between VietTruyen App ↔ Gemini Browser Proxy
// Improvements: role-based pairing, compression, chunk batching,
//               smart keepalive, message limits, metrics
// Deploy: Render.com (Free Tier optimized)
// ================================================

import { WebSocketServer } from 'ws';
import { createServer } from 'http';

const PORT = parseInt(process.env.PORT) || 8080;

// ── Config ──────────────────────────────────────
const PING_INTERVAL_MS = 20_000;       // 20s — safe for Render 60s idle timeout
const PONG_TIMEOUT_MS = 10_000;        // 10s to reply pong before considered dead
const MAX_MESSAGE_SIZE = 5 * 1024 * 1024; // 5MB max message
const BATCH_WINDOW_MS = 30;            // batch chunks within 30ms window
const ROOM_CODE_REGEX = /^[a-zA-Z0-9_\-]{1,64}$/;

// ── Metrics ─────────────────────────────────────
const metrics = {
    messagesRelayed: 0,
    bytesRelayed: 0,
    connectionsTotal: 0,
    batchesSent: 0,
    startedAt: Date.now()
};

// ── Room Management ─────────────────────────────
// rooms: Map<code, { app: Set<ws>, proxy: Set<ws> }>
const rooms = new Map();

function getRoom(code) {
    if (!rooms.has(code)) {
        rooms.set(code, { app: new Set(), proxy: new Set() });
    }
    return rooms.get(code);
}

function cleanupRoom(code) {
    const room = rooms.get(code);
    if (room && room.app.size === 0 && room.proxy.size === 0) {
        rooms.delete(code);
    }
}

function getRoomStats() {
    const stats = [];
    for (const [code, room] of rooms) {
        stats.push({ code, apps: room.app.size, proxies: room.proxy.size });
    }
    return stats;
}

// ── Chunk Batcher ───────────────────────────────
// Accumulates WS messages within a time window and sends as single batch
class ChunkBatcher {
    constructor(target, windowMs = BATCH_WINDOW_MS) {
        this.target = target;   // target WebSocket
        this.windowMs = windowMs;
        this.buffer = [];
        this.timer = null;
    }

    add(data) {
        this.buffer.push(data);
        if (!this.timer) {
            this.timer = setTimeout(() => this.flush(), this.windowMs);
        }
    }

    flush() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.buffer.length === 0) return;

        if (this.target.readyState !== 1) {
            this.buffer = [];
            return;
        }

        if (this.buffer.length === 1) {
            // Single message — send directly (no batch overhead)
            this.target.send(this.buffer[0]);
            metrics.messagesRelayed++;
            metrics.bytesRelayed += this.buffer[0].length;
        } else {
            // Multiple messages — wrap in batch envelope
            const batchMsg = JSON.stringify({
                event_type: 'batch',
                items: this.buffer.map(raw => {
                    try { return JSON.parse(raw); } catch { return raw; }
                })
            });
            this.target.send(batchMsg);
            metrics.messagesRelayed += this.buffer.length;
            metrics.bytesRelayed += batchMsg.length;
            metrics.batchesSent++;
        }
        this.buffer = [];
    }

    destroy() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.buffer = [];
    }
}

// ── Role Detection ──────────────────────────────
// Auto-detect role from first message if not provided via URL param
function detectRoleFromMessage(msg) {
    try {
        const parsed = JSON.parse(msg);
        // App sends: { request_id, method, path, headers, body }
        if (parsed.request_id && parsed.method && parsed.path) return 'app';
        // Proxy sends: { request_id, event_type: 'chunk'|'response_headers'|'stream_close'|'error' }
        if (parsed.request_id && parsed.event_type) return 'proxy';
    } catch { /* not JSON */ }
    return null;
}

// ── HTTP Server ─────────────────────────────────
const httpServer = createServer((req, res) => {
    // CORS headers for health checks
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.url === '/health' || req.url === '/') {
        const uptime = Math.floor(process.uptime());
        const roomStats = getRoomStats();
        const totalClients = roomStats.reduce((sum, r) => sum + r.apps + r.proxies, 0);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            version: '2.0.0',
            uptime,
            rooms: rooms.size,
            connections: totalClients,
            metrics: {
                messagesRelayed: metrics.messagesRelayed,
                bytesRelayed: metrics.bytesRelayed,
                batchesSent: metrics.batchesSent,
                connectionsTotal: metrics.connectionsTotal,
                uptimeHours: ((Date.now() - metrics.startedAt) / 3600000).toFixed(1)
            },
            roomDetails: roomStats
        }));
        return;
    }

    res.writeHead(404);
    res.end('Not Found');
});

// ── WebSocket Server ────────────────────────────
const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_MESSAGE_SIZE,
    perMessageDeflate: {
        // Compression tuning for Render free tier bandwidth savings
        zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
        zlibInflateOptions: { chunkSize: 10 * 1024 },
        clientNoContextTakeover: true,  // Save server memory
        serverNoContextTakeover: true,  // Save server memory
        serverMaxWindowBits: 10,
        concurrencyLimit: 10,
        threshold: 128 // Only compress messages > 128 bytes
    }
});

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const code = url.searchParams.get('code') || 'default';
    let role = url.searchParams.get('role') || null; // 'app' | 'proxy' | null (auto-detect)

    // Validate room code
    if (!ROOM_CODE_REGEX.test(code)) {
        ws.close(4001, 'Invalid room code');
        return;
    }

    const room = getRoom(code);
    const clientId = Math.random().toString(36).slice(2, 8);
    let roleAssigned = false;

    // Assign role if known upfront
    if (role === 'app' || role === 'proxy') {
        room[role].add(ws);
        roleAssigned = true;
    }

    metrics.connectionsTotal++;
    console.log(`✅ [${code}] Client ${clientId} connected (role=${role || 'pending'}, apps=${room.app.size}, proxies=${room.proxy.size})`);

    // Per-target batcher map: targetWs → ChunkBatcher
    const batchers = new Map();

    function getBatcher(targetWs) {
        if (!batchers.has(targetWs)) {
            batchers.set(targetWs, new ChunkBatcher(targetWs));
        }
        return batchers.get(targetWs);
    }

    // ── Message Handler ────────────────────────
    ws.on('message', (data) => {
        const msg = data.toString();

        // Size warning
        if (msg.length > 1_000_000) {
            console.warn(`⚠️ [${code}] Large message from ${clientId}: ${(msg.length / 1024).toFixed(0)}KB`);
        }

        // Auto-detect role from first message if not assigned
        if (!roleAssigned) {
            const detected = detectRoleFromMessage(msg);
            if (detected) {
                role = detected;
                room[role].add(ws);
                roleAssigned = true;
                console.log(`🔍 [${code}] Auto-detected ${clientId} as "${role}"`);
            } else {
                // Fallback: add to both and broadcast (legacy behavior)
                role = 'unknown';
                roleAssigned = true;
                console.log(`❓ [${code}] Could not detect role for ${clientId}, using broadcast mode`);
            }
        }

        // ── Route message based on role ────────
        let targets;
        if (role === 'app') {
            // App → all proxies in room
            targets = room.proxy;
        } else if (role === 'proxy') {
            // Proxy → all apps in room
            targets = room.app;
        } else {
            // Unknown: broadcast to everyone else (legacy compat)
            targets = new Set([...room.app, ...room.proxy]);
            targets.delete(ws);
        }

        // Check if this is a streamable chunk (proxy → app direction, chunk event)
        let isChunk = false;
        if (role === 'proxy') {
            try {
                const parsed = JSON.parse(msg);
                isChunk = parsed.event_type === 'chunk';
            } catch { /* not json */ }
        }

        for (const target of targets) {
            if (target === ws || target.readyState !== 1) continue;

            if (isChunk) {
                // Batch chunks for efficiency
                getBatcher(target).add(msg);
            } else {
                // Non-chunk messages: flush any pending batch first, then send immediately
                const batcher = batchers.get(target);
                if (batcher) batcher.flush();

                target.send(msg);
                metrics.messagesRelayed++;
                metrics.bytesRelayed += msg.length;
            }
        }
    });

    // ── Keepalive ──────────────────────────────
    let alive = true;

    ws.on('pong', () => { alive = true; });

    const pingInterval = setInterval(() => {
        if (!alive) {
            console.log(`💀 [${code}] Client ${clientId} (${role}) dead — no pong. Terminating.`);
            ws.terminate();
            return;
        }
        alive = false;
        if (ws.readyState === 1) ws.ping();
    }, PING_INTERVAL_MS);

    // ── Cleanup ────────────────────────────────
    ws.on('close', () => {
        clearInterval(pingInterval);

        // Cleanup batchers
        for (const batcher of batchers.values()) {
            batcher.flush(); // send remaining
            batcher.destroy();
        }
        batchers.clear();

        // Remove from room
        if (role === 'app') room.app.delete(ws);
        else if (role === 'proxy') room.proxy.delete(ws);
        else {
            room.app.delete(ws);
            room.proxy.delete(ws);
        }

        console.log(`❌ [${code}] Client ${clientId} (${role}) disconnected (apps=${room.app.size}, proxies=${room.proxy.size})`);
        cleanupRoom(code);
    });

    ws.on('error', (err) => {
        console.error(`⚠️ [${code}] Client ${clientId} error:`, err.message);
    });

    // NOTE: server_info removed — proxy apps (AI Studio) crash on unexpected messages.
    // Capabilities can be checked via /health endpoint instead.
});

// ── Graceful Shutdown ───────────────────────────
function gracefulShutdown(signal) {
    console.log(`\n🛑 ${signal} received. Closing all connections...`);
    wss.clients.forEach(ws => {
        ws.close(1001, 'Server shutting down');
    });
    httpServer.close(() => {
        console.log('👋 Server shut down cleanly.');
        process.exit(0);
    });
    // Force exit after 5s
    setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── Start ───────────────────────────────────────
httpServer.listen(PORT, () => {
    console.log(`🔌 WS Relay Server v2.0.0 running on port ${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   Features: role-pairing, compression, chunk-batching, smart-keepalive`);
    console.log(`   Max message: ${MAX_MESSAGE_SIZE / 1024 / 1024}MB | Ping: ${PING_INTERVAL_MS / 1000}s`);
});
