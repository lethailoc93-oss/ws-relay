// ================================================
// WebSocket Relay Server v2.4 — Enhanced AI Processing
// Routes messages between VietTruyen App ↔ Gemini Browser Proxy
// Features: role-based pairing, compression, chunk batching,
//           smart keepalive, message limits, metrics,
//           empty-return fix, thinking budget, google search toggle,
//           round-robin proxy, client disconnect cleanup
// Deploy: Render.com (Free Tier optimized)
// ================================================
import { randomBytes } from 'crypto';

import { WebSocketServer } from 'ws';
import { createServer } from 'http';

const PORT = parseInt(process.env.PORT) || 8080;

// ── Config ──────────────────────────────────────
const PING_INTERVAL_MS = 20_000;       // 20s — safe for Render 60s idle timeout
const PONG_TIMEOUT_MS = 10_000;        // 10s to reply pong before considered dead
const MAX_MESSAGE_SIZE = 5 * 1024 * 1024; // 5MB max message
const BATCH_WINDOW_MS = 30;            // batch chunks within 30ms window
const ROOM_CODE_REGEX = /^[a-zA-Z0-9_\-]{1,64}$/;

// ── AI Processing Config ────────────────────────
const EMPTY_RETURN_FIX_ENABLED = (process.env.EMPTY_RETURN_FIX ?? 'true') !== 'false';

// ── Metrics ─────────────────────────────────────
const metrics = {
    messagesRelayed: 0,
    bytesRelayed: 0,
    connectionsTotal: 0,
    batchesSent: 0,
    heartbeatsReceived: 0,
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
        // Skip heartbeat/ping for role detection
        if (parsed.event_type === 'heartbeat' || parsed.event_type === 'ping') return null;
        // App sends: { request_id, method, path, headers, body }
        if (parsed.request_id && parsed.method && parsed.path) return 'app';
        // Proxy sends: { request_id, event_type: 'chunk'|'response_headers'|'stream_close'|'error' }
        if (parsed.request_id && parsed.event_type) return 'proxy';
    } catch { /* not JSON */ }
    return null;
}

// ── AI Request Processing ───────────────────────
// Generate random 64-char hex string for empty-return fix
function rand64() {
    return randomBytes(32).toString('hex');
}

// Normalize role names: assistant/model → model, user → user
function normRole(r) {
    if (r === 'assistant' || r === 'model') return 'model';
    if (r === 'user') return 'user';
    return r || '';
}

/**
 * Empty Return Fix — Prevents Gemini from returning empty responses.
 * When conversation history ends with assistant/model role, Gemini may
 * interpret it as "continue from here" and return empty. This fix injects
 * dummy assistant messages to break that pattern.
 * Extracted from build-反代 research (index.js:154-182).
 */
function applyEmptyReturnFix(rawMessages) {
    const msgs = Array.isArray(rawMessages) ? [...rawMessages] : [];
    if (msgs.length === 0) return msgs;

    const lastIdx = msgs.length - 1;
    const last = msgs[lastIdx];
    const lastRole = normRole(last.role);
    const prev = msgs[lastIdx - 1];
    const prevRole = prev ? normRole(prev.role) : '';

    if (lastRole === 'model') {
        if (prevRole !== 'model') {
            msgs.splice(lastIdx, 0, { role: 'assistant', content: rand64() });
        }
        return msgs;
    }

    if (lastRole === 'user') {
        msgs[lastIdx] = { ...last, role: 'assistant' };
        const newPrev = msgs[lastIdx - 1];
        const newPrevRole = newPrev ? normRole(newPrev.role) : '';
        if (newPrevRole !== 'model') {
            msgs.splice(lastIdx, 0, { role: 'assistant', content: rand64() });
        }
        return msgs;
    }

    return msgs;
}

/**
 * Parse thinking budget from request headers or query params.
 * Supports: x-thinking-budget header, thinking_budget query param.
 * Returns null if not specified, or a validated integer [0, 32768].
 */
function parseThinkingBudget(headers, queryParams) {
    const raw = headers['x-thinking-budget'] || queryParams.thinking_budget;
    if (raw == null) return null;
    const num = parseInt(raw, 10);
    if (isNaN(num) || num < 0) return null;
    return Math.min(num, 32768);
}

/**
 * Parse Google Search toggle from request headers or query params.
 * Supports: x-google-search header, google_search query param.
 * Returns true/false/null.
 */
function parseGoogleSearch(headers, queryParams) {
    const raw = headers['x-google-search'] || queryParams.google_search;
    if (raw == null) return null;
    const val = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(val)) return true;
    if (['0', 'false', 'no', 'off'].includes(val)) return false;
    return null;
}

/**
 * Apply AI processing enhancements to the request body.
 * - Empty return fix for /chat/completions
 * - Thinking budget injection for Gemini-native paths
 * - Google Search tool injection
 */
function processRequestBody(body, finalPath, headers, queryParams) {
    if (!body) return body;

    try {
        const parsed = JSON.parse(body);
        let modified = false;

        // ── Empty Return Fix ──
        if (EMPTY_RETURN_FIX_ENABLED && finalPath.includes('/chat/completions') && Array.isArray(parsed.messages)) {
            const fixed = applyEmptyReturnFix(parsed.messages);
            if (fixed.length !== parsed.messages.length) {
                parsed.messages = fixed;
                modified = true;
                console.log(`[AI Process] Empty return fix applied: ${parsed.messages.length} → ${fixed.length} messages`);
            }
        }

        // ── Thinking Budget ──
        const thinkingBudget = parseThinkingBudget(headers, queryParams);
        if (thinkingBudget != null) {
            // For Gemini-native paths, inject thinkingConfig
            if (finalPath.includes(':generateContent') || finalPath.includes(':streamGenerateContent')) {
                if (!parsed.generationConfig) parsed.generationConfig = {};
                parsed.generationConfig.thinkingConfig = {
                    thinkingBudget: thinkingBudget,
                    includeThoughts: true
                };
                modified = true;
            }
            // For OpenAI-compat, Gemini handles it natively via extra_body
            console.log(`[AI Process] Thinking budget set: ${thinkingBudget}`);
        }

        // ── Google Search Toggle ──
        const googleSearch = parseGoogleSearch(headers, queryParams);
        if (googleSearch === true) {
            // For Gemini-native paths
            if (finalPath.includes(':generateContent') || finalPath.includes(':streamGenerateContent')) {
                if (!Array.isArray(parsed.tools)) parsed.tools = [];
                const hasSearch = parsed.tools.some(t => t && t.googleSearch);
                if (!hasSearch) {
                    parsed.tools.push({ googleSearch: {} });
                    modified = true;
                }
            }
            console.log(`[AI Process] Google Search enabled`);
        }

        if (modified) return JSON.stringify(parsed);
    } catch { /* not JSON or parse error — return original */ }

    return body;
}

// ── Proxy Selection (Round-Robin) ───────────────
// Track last-used proxy index per room for fair distribution
const proxyRoundRobin = new Map();

function selectProxy(roomCode, proxies) {
    if (proxies.length === 0) return null;
    if (proxies.length === 1) return proxies[0];

    const lastIdx = proxyRoundRobin.get(roomCode) || 0;
    const nextIdx = (lastIdx + 1) % proxies.length;
    proxyRoundRobin.set(roomCode, nextIdx);
    return proxies[nextIdx];
}

// ── HTTP-to-WS Bridge ───────────────────────────
// Pending HTTP requests waiting for proxy response
// Map<request_id, { res, status, headersSent, timer }>
const httpBridgeRequests = new Map();

/**
 * Handle proxy response message for HTTP bridge requests.
 * Called from the WS message handler when a response targets a bridge request.
 */
function handleBridgeResponse(msg) {
    const pending = httpBridgeRequests.get(msg.request_id);
    console.log(`[Bridge Response] ${msg.request_id?.slice(0,20)} event=${msg.event_type} found=${!!pending} pending_count=${httpBridgeRequests.size}`);
    if (!pending) return false;

    switch (msg.event_type) {
        case 'response_headers':
            pending.status = msg.status || 200;
            pending.respHeaders = msg.headers || {};
            return true;

        case 'chunk':
            if (!pending.headersSent) {
                pending.headersSent = true;
                pending.res.writeHead(pending.status || 200, {
                    'Content-Type': pending.respHeaders?.['content-type'] || 'application/json',
                    'Transfer-Encoding': 'chunked',
                    'Access-Control-Allow-Origin': '*',
                });
            }
            pending.res.write(msg.data);
            return true;

        case 'stream_close':
            if (!pending.headersSent) {
                pending.res.writeHead(pending.status || 200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                });
            }
            pending.res.end();
            clearTimeout(pending.timer);
            httpBridgeRequests.delete(msg.request_id);
            return true;

        case 'error':
            if (!pending.headersSent) {
                pending.res.writeHead(msg.status || 500, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                });
            }
            pending.res.end(JSON.stringify({ error: { message: msg.message, code: msg.status } }));
            clearTimeout(pending.timer);
            httpBridgeRequests.delete(msg.request_id);
            return true;
    }
    return false;
}

// ── HTTP Server ─────────────────────────────────
const httpServer = createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

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
            version: '2.4.0',
            uptime,
            rooms: rooms.size,
            connections: totalClients,
            httpBridge: { active: httpBridgeRequests.size },
            metrics: {
                messagesRelayed: metrics.messagesRelayed,
                bytesRelayed: metrics.bytesRelayed,
                batchesSent: metrics.batchesSent,
                heartbeatsReceived: metrics.heartbeatsReceived,
                connectionsTotal: metrics.connectionsTotal,
                uptimeHours: ((Date.now() - metrics.startedAt) / 3600000).toFixed(1)
            },
            roomDetails: roomStats
        }));
        return;
    }

    // Room status check: /status/ROOM_CODE
    const statusMatch = req.url.match(/^\/status\/([a-zA-Z0-9_-]+)/);
    if (statusMatch) {
        const code = statusMatch[1];
        const room = rooms.get(code);
        const proxyCount = room ? [...room.proxy].filter(ws => ws.readyState === 1).length : 0;
        const appCount = room ? [...room.app].filter(ws => ws.readyState === 1).length : 0;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            code,
            proxyConnected: proxyCount > 0,
            proxies: proxyCount,
            apps: appCount,
            status: proxyCount > 0 ? 'ready' : 'no_proxy'
        }));
        return;
    }

    // ═══════════════════════════════════════════════
    // HTTP Bridge: /api/ROOM_CODE/any/api/path
    // Forwards HTTP request → proxy via WS → streams response back
    // Usage: SillyTavern → https://relay-url/api/ROOM_CODE/v1beta/models/...
    // ═══════════════════════════════════════════════
    const apiMatch = req.url.match(/^\/api\/([a-zA-Z0-9_-]+)(\/.*)/);
    if (apiMatch) {
        const roomCode = apiMatch[1];
        const apiPath = apiMatch[2]; // e.g., /v1beta/models/gemini-2.0-flash:generateContent

        // Check room & proxy
        const room = rooms.get(roomCode);
        const proxies = room ? [...room.proxy].filter(ws => ws.readyState === 1) : [];
        if (proxies.length === 0) {
            res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({
                error: {
                    message: `No proxy connected in room "${roomCode}". Open AI Studio Proxy App first.`,
                    code: 503
                }
            }));
            return;
        }

        // Collect request body
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            const requestId = `bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

            // Parse URL for query params
            const urlObj = new URL(req.url, `http://localhost:${PORT}`);
            const queryParams = {};
            urlObj.searchParams.forEach((v, k) => queryParams[k] = v);

            // Clean headers
            const headers = {};
            for (const [k, v] of Object.entries(req.headers)) {
                if (!['host', 'connection', 'content-length', 'transfer-encoding'].includes(k.toLowerCase())) {
                    headers[k] = v;
                }
            }

            // ── Path rewriting: OpenAI → Gemini ──
            // SillyTavern sends OpenAI-format paths, Gemini API uses different paths
            // /v1/chat/completions      → /v1beta/openai/chat/completions
            // /v1/models                → /v1beta/openai/models
            // /chat/completions         → /v1beta/openai/chat/completions
            // /models                   → /v1beta/openai/models
            // /v1beta/... paths pass through unchanged (already Gemini-native)
            let finalPath = apiPath;
            if (!finalPath.startsWith('/v1beta/')) {
                // Strip /v1 prefix if present
                const stripped = finalPath.replace(/^\/v1\//, '/');
                finalPath = '/v1beta/openai' + stripped;
            }

            // ── Clean request body for Gemini OpenAI compatibility ──
            // SillyTavern sends OpenAI params that Gemini doesn't support
            let cleanBody = body || null;
            if (cleanBody && finalPath.includes('/chat/completions')) {
                try {
                    const parsed = JSON.parse(cleanBody);
                    // Remove unsupported OpenAI parameters
                    const unsupported = [
                        'logit_bias', 'logprobs', 'top_logprobs',
                        'user', 'service_tier', 'store',
                        'frequency_penalty', 'presence_penalty',
                        'seed', 'tools', 'tool_choice',
                        'response_format', 'extra_body',
                        'n', 'suffix'
                    ];
                    for (const key of unsupported) {
                        delete parsed[key];
                    }
                    // Gemini uses max_completion_tokens, but also accepts max_tokens
                    // Just ensure we don't have both
                    if (parsed.max_completion_tokens && parsed.max_tokens) {
                        delete parsed.max_tokens;
                    }
                    cleanBody = JSON.stringify(parsed);
                    console.log(`[Bridge] Cleaned body: model=${parsed.model} stream=${parsed.stream} messages=${parsed.messages?.length}`);
                } catch { /* keep original body */ }
            }

            // ── AI Processing Enhancements ──
            // Apply empty-return fix, thinking budget, google search
            cleanBody = processRequestBody(cleanBody, finalPath, headers, queryParams);

            // Build request spec (same format as WS app sends)
            const requestSpec = {
                request_id: requestId,
                method: req.method,
                path: finalPath,
                headers,
                body: cleanBody,
                query_params: queryParams,
            };

            // Register pending response
            const timer = setTimeout(() => {
                if (httpBridgeRequests.has(requestId)) {
                    const p = httpBridgeRequests.get(requestId);
                    if (!p.headersSent) {
                        p.res.writeHead(504, { 'Content-Type': 'application/json' });
                    }
                    p.res.end(JSON.stringify({ error: { message: 'Request timeout (5 min)', code: 504 } }));
                    httpBridgeRequests.delete(requestId);
                }
            }, 5 * 60 * 1000);

            httpBridgeRequests.set(requestId, {
                res,
                status: 200,
                respHeaders: {},
                headersSent: false,
                timer,
            });

            // Send to proxy (round-robin selection)
            const proxy = selectProxy(roomCode, proxies);
            const msgStr = JSON.stringify(requestSpec);
            proxy.send(msgStr);
            metrics.messagesRelayed++;
            metrics.bytesRelayed += msgStr.length;

            console.log(`[HTTP Bridge] ${requestId} → ${req.method} ${finalPath}${finalPath !== apiPath ? ` (rewritten from ${apiPath})` : ''} (room: ${roomCode}) | pending=${httpBridgeRequests.size}`);
        });

        // Handle client disconnect — clean up pending request
        req.on('close', () => {
            // Find and cleanup the pending request for this response
            for (const [reqId, pending] of httpBridgeRequests) {
                if (pending.res === res && !pending.headersSent) {
                    clearTimeout(pending.timer);
                    httpBridgeRequests.delete(reqId);
                    console.log(`[HTTP Bridge] Client disconnected, cleaned up ${reqId.slice(0, 20)}`);
                    break;
                }
            }
        });
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

        // ── Handle client heartbeat/ping (mobile keep-alive) ──
        try {
            const parsed = JSON.parse(msg);
            if (parsed.event_type === 'heartbeat' || parsed.event_type === 'ping') {
                metrics.heartbeatsReceived++;
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ event_type: 'pong', ts: Date.now() }));
                }
                return; // Don't route heartbeat to other clients
            }
        } catch { /* not JSON */ }

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

        // ── No target available: send error back ────
        // When app sends request but no proxy is connected → reply with error
        // so the client doesn't hang indefinitely waiting for a response
        if (role === 'app' && targets.size === 0) {
            try {
                const parsed = JSON.parse(msg);
                if (parsed.request_id) {
                    const errMsg = JSON.stringify({
                        request_id: parsed.request_id,
                        event_type: 'error',
                        status: 503,
                        message: 'No proxy connected. Hãy mở AI Studio Proxy App và kiểm tra kết nối.'
                    });
                    ws.send(errMsg);
                    console.log(`⚠️ [${code}] No proxy available for request ${parsed.request_id.slice(0, 8)} from ${clientId}`);
                }
            } catch { /* not a request, ignore */ }
        }

        // Check if this is a streamable chunk (proxy → app direction, chunk event)
        let isChunk = false;
        if (role === 'proxy') {
            try {
                const parsed = JSON.parse(msg);
                isChunk = parsed.event_type === 'chunk';

                // Route bridge responses to HTTP handler (not WS apps)
                if (parsed.request_id && parsed.request_id.startsWith('bridge-')) {
                    console.log(`[Bridge Intercept] ${parsed.request_id.slice(0,20)} event=${parsed.event_type} data_len=${parsed.data?.length || 0}`);
                    handleBridgeResponse(parsed);
                    return; // Don't forward to WS app clients
                }
            } catch { /* not json */ }
        }

        // Count alive targets for routing
        let aliveTargets = 0;
        for (const target of targets) {
            if (target === ws || target.readyState !== 1) continue;
            aliveTargets++;

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

        // Edge case: targets exist but none are alive (stale connections)
        if (role === 'app' && targets.size > 0 && aliveTargets === 0) {
            try {
                const parsed = JSON.parse(msg);
                if (parsed.request_id) {
                    const errMsg = JSON.stringify({
                        request_id: parsed.request_id,
                        event_type: 'error',
                        status: 503,
                        message: 'Proxy đang offline hoặc mất kết nối. Hãy mở lại AI Studio Proxy App.'
                    });
                    ws.send(errMsg);
                    console.log(`⚠️ [${code}] All proxies dead for request ${parsed.request_id.slice(0, 8)} from ${clientId}`);
                }
            } catch { /* ignore */ }
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
    console.log(`🔌 WS Relay Server v2.4.0 running on port ${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   Features: role-pairing, compression, chunk-batching, smart-keepalive, empty-return-fix, thinking-budget, google-search`);
    console.log(`   Max message: ${MAX_MESSAGE_SIZE / 1024 / 1024}MB | Ping: ${PING_INTERVAL_MS / 1000}s`);
});
