// ================================================
// WebSocket Relay Server v2.5 — Multi-API Support
// Routes messages between VietTruyen App ↔ Gemini Browser Proxy
// Supports: Custom OpenAI-compatible + Google AI Studio (Gemini native)
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

// ── Clean Gemini Native Body ────────────────────
// SillyTavern sends extra params that Gemini API rejects as "invalid argument"
function cleanGeminiBody(bodyStr) {
    try {
        const parsed = JSON.parse(bodyStr);

        // Allowed top-level fields for generateContent / streamGenerateContent
        const allowedTopLevel = [
            'contents', 'tools', 'toolConfig', 'safetySettings',
            'systemInstruction', 'generationConfig', 'cachedContent'
        ];

        const removed = [];
        for (const key of Object.keys(parsed)) {
            if (!allowedTopLevel.includes(key)) {
                removed.push(key);
                delete parsed[key];
            }
        }

        // Clean generationConfig
        if (parsed.generationConfig) {
            const allowedGenConfig = [
                'stopSequences', 'responseMimeType', 'responseSchema',
                'candidateCount', 'maxOutputTokens', 'temperature',
                'topP', 'topK', 'presencePenalty', 'frequencyPenalty',
                'responseLogprobs', 'logprobs', 'thinkingConfig', 'seed'
            ];

            for (const key of Object.keys(parsed.generationConfig)) {
                if (!allowedGenConfig.includes(key)) {
                    removed.push(`generationConfig.${key}`);
                    delete parsed.generationConfig[key];
                }
            }

            // topK=0 is invalid for most models
            if (parsed.generationConfig.topK === 0) {
                removed.push('generationConfig.topK=0');
                delete parsed.generationConfig.topK;
            }

            // candidateCount > 1 not supported for streaming
            if (parsed.generationConfig.candidateCount > 1) {
                parsed.generationConfig.candidateCount = 1;
                removed.push('generationConfig.candidateCount→1');
            }

            // Remove empty stopSequences array (can cause issues)
            if (Array.isArray(parsed.generationConfig.stopSequences) && parsed.generationConfig.stopSequences.length === 0) {
                delete parsed.generationConfig.stopSequences;
            }
        }

        if (removed.length > 0) {
            console.log(`[Gemini Clean] Removed: ${removed.join(', ')}`);
        }

        const contentCount = parsed.contents?.length || 0;
        const hasSystem = !!parsed.systemInstruction;
        console.log(`[Gemini Clean] contents=${contentCount} systemInstruction=${hasSystem} safetySettings=${parsed.safetySettings?.length || 0}`);

        return JSON.stringify(parsed);
    } catch {
        return bodyStr;
    }
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

    // Capture error responses for debugging
    if (msg.event_type === 'error' || (msg.event_type === 'chunk' && msg.data)) {
        const roomCode = msg.request_id?.match(/bridge-\d+-([a-z0-9]+)/)?.[1] || 'unknown';
        // Try to extract error from chunk data (Gemini sends errors as response body)
        if (msg.event_type === 'chunk' && msg.data) {
            try {
                const chunkData = JSON.parse(msg.data);
                if (chunkData.error) {
                    captureDebug(roomCode + '_errors', {
                        request_id: msg.request_id,
                        error: chunkData.error,
                        status: msg.status,
                    });
                }
            } catch { /* not JSON error */ }
        }
        if (msg.event_type === 'error') {
            captureDebug(roomCode + '_errors', {
                request_id: msg.request_id,
                error: msg.message,
                status: msg.status,
            });
        }
    }

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

// ── Debug Request Capture ────────────────────────
// Circular buffer: last 5 requests per room for debugging
const debugLog = new Map(); // roomCode → [{ts, method, originalPath, finalPath, queryParams, originalBody, cleanedBody, isGeminiNative}]
function captureDebug(roomCode, entry) {
    if (!debugLog.has(roomCode)) debugLog.set(roomCode, []);
    const log = debugLog.get(roomCode);
    log.push({ ts: new Date().toISOString(), ...entry });
    if (log.length > 5) log.shift();
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
            version: '2.5.0',
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

    // Debug endpoint: /debug/ROOM_CODE — view last 5 captured requests
    const debugMatch = req.url.match(/^\/debug\/([a-zA-Z0-9_-]+)/);
    if (debugMatch) {
        const code = debugMatch[1];
        const entries = debugLog.get(code) || [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ room: code, requests: entries }, null, 2));
        return;
    }

    // ═══════════════════════════════════════════════
    // HTTP Bridge: /api/ROOM_CODE/any/api/path
    // Forwards HTTP request → proxy via WS → streams response back
    // Usage: SillyTavern → https://relay-url/api/ROOM_CODE/v1beta/models/...
    // ═══════════════════════════════════════════════
    // ═══════════════════════════════════════════════
    const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
    const apiMatch = parsedUrl.pathname.match(/^\/api\/([a-zA-Z0-9_-]+)(\/.*)/);
    if (apiMatch) {
        const roomCode = apiMatch[1];
        const apiPath = apiMatch[2]; // e.g., /v1beta/models/gemini-2.0-flash:generateContent (without query string)

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

            // Extract query params
            const queryParams = {};
            parsedUrl.searchParams.forEach((v, k) => queryParams[k] = v);

            // ── Strip API key ──
            // SillyTavern "Google AI Studio" mode sends ?key=API_KEY
            // Proxy already has OAuth — strip to avoid conflicts
            delete queryParams.key;

            // Clean headers — also strip authorization for same reason
            const headers = {};
            for (const [k, v] of Object.entries(req.headers)) {
                if (!['host', 'connection', 'content-length', 'transfer-encoding', 'authorization', 'x-goog-api-key'].includes(k.toLowerCase())) {
                    headers[k] = v;
                }
            }

            // ── Path rewriting: Auto-detect API format ──
            // Mode 1 — OpenAI-compatible (Custom OpenAI in SillyTavern):
            //   /v1/chat/completions      → /v1beta/openai/chat/completions
            //   /v1/models                → /v1beta/openai/models
            //   /chat/completions         → /v1beta/openai/chat/completions
            //   /models                   → /v1beta/openai/models
            // Mode 2 — Gemini native (Google AI Studio in SillyTavern):
            //   /v1beta/... paths pass through unchanged
            //   /models/...:streamGenerateContent → prepends /v1beta
            let finalPath = apiPath;
            const isGeminiNative = finalPath.includes(':streamGenerateContent') 
                                || finalPath.includes(':generateContent') 
                                || finalPath.startsWith('/v1beta/models');
                                
            if (isGeminiNative) {
                // Ensure it starts with /v1beta/
                if (!finalPath.startsWith('/v1beta/')) {
                    finalPath = '/v1beta' + (finalPath.startsWith('/') ? '' : '/') + finalPath;
                }
            } else {
                // OpenAI format → rewrite to Gemini OpenAI-compatible endpoint
                let stripped = finalPath.replace(/^\/v1\//, '/');
                if (!stripped.startsWith('/v1beta/openai')) {
                    finalPath = '/v1beta/openai' + (stripped.startsWith('/') ? '' : '/') + stripped;
                } else {
                    finalPath = stripped;
                }
            }

            // ── Clean request body ──
            let cleanBody = body || null;
            if (cleanBody && finalPath.includes('/chat/completions')) {
                // OpenAI mode: strip unsupported params (min_p, repetition_penalty, etc.)
                try {
                    const parsed = JSON.parse(cleanBody);
                    const allowed = [
                        'messages', 'model', 'temperature', 'top_p', 'top_k',
                        'max_tokens', 'max_completion_tokens', 'stop', 'stream',
                        'presence_penalty', 'frequency_penalty', 'response_format',
                        'tools', 'tool_choice'
                    ];
                    
                    for (const key of Object.keys(parsed)) {
                        if (!allowed.includes(key)) {
                            delete parsed[key];
                        }
                    }
                    
                    if (parsed.max_completion_tokens && parsed.max_tokens) {
                        delete parsed.max_tokens;
                    }
                    cleanBody = JSON.stringify(parsed);
                    console.log(`[Bridge] Cleaned OpenAI body: model=${parsed.model} stream=${parsed.stream} messages=${parsed.messages?.length}`);
                } catch { /* keep original body */ }
            } else if (cleanBody && isGeminiNative) {
                // Gemini native mode: strip unsupported fields
                cleanBody = cleanGeminiBody(cleanBody);
            }

            // Analyze body structure for debug (don't store raw body - too large)
            let bodyAnalysis = null;
            if (body) {
                try {
                    const p = JSON.parse(body);
                    bodyAnalysis = {
                        topLevelKeys: Object.keys(p),
                        bodyLength: body.length,
                        contentsCount: p.contents?.length,
                        contentsRoles: p.contents?.map(c => c.role),
                        contentsSizes: p.contents?.map(c => JSON.stringify(c).length),
                        hasGenerationConfig: !!p.generationConfig,
                        generationConfigKeys: p.generationConfig ? Object.keys(p.generationConfig) : null,
                        hasSafetySettings: !!p.safetySettings,
                        safetyCount: p.safetySettings?.length,
                        hasSystemInstruction: !!p.systemInstruction,
                    };
                } catch { bodyAnalysis = { raw: body.slice(0, 500), parseError: true }; }
            }
            captureDebug(roomCode, {
                method: req.method,
                originalPath: apiPath,
                finalPath,
                queryParams,
                isGeminiNative,
                bodyAnalysis,
                cleanedBodyLength: cleanBody?.length,
            });

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

            // Send to proxy (pick first available)
            const proxy = proxies[0];
            const msgStr = JSON.stringify(requestSpec);
            proxy.send(msgStr);
            metrics.messagesRelayed++;
            metrics.bytesRelayed += msgStr.length;

            const mode = isGeminiNative ? 'AI-Studio' : 'OpenAI';
            console.log(`[HTTP Bridge] ${requestId} → ${req.method} ${finalPath} [${mode}]${finalPath !== apiPath ? ` (from ${apiPath})` : ''} (room: ${roomCode}) | pending=${httpBridgeRequests.size}`);
        });

        // Handle client disconnect
        req.on('close', () => {
            if (httpBridgeRequests.has(`bridge-req-abort`)) {
                // Client disconnected before response
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
    console.log(`🔌 WS Relay Server v2.5.0 running on port ${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   API modes: Custom OpenAI-compatible + Google AI Studio (Gemini native)`);
    console.log(`   Features: role-pairing, compression, chunk-batching, smart-keepalive`);
    console.log(`   Max message: ${MAX_MESSAGE_SIZE / 1024 / 1024}MB | Ping: ${PING_INTERVAL_MS / 1000}s`);
});
