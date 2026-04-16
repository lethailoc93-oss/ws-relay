import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';

// ================================================
// Local Proxy Server — HTTP↔WS Bridge (ESM)
// Receives HTTP requests from clients (SillyTavern, etc.)
// and forwards them to browser proxy via WebSocket.
// ================================================

// ── Config ──────────────────────────────────────
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8889');
const WS_PORT = parseInt(process.env.WS_PORT || '9998');
const HOST = process.env.HOST || '127.0.0.1';
const QUEUE_TIMEOUT_MS = 600_000; // 10 min request timeout
const MAX_BODY_SIZE = 100 * 1024 * 1024; // 100MB
const EMPTY_RETURN_FIX_ENABLED = (process.env.EMPTY_RETURN_FIX ?? 'true') !== 'false';

// ── Logger ──────────────────────────────────────
class Logger {
    constructor(name = 'ProxyServer') { this.name = name; }

    _fmt(level, msg) {
        return `[${level}] ${new Date().toISOString()} [${this.name}] ${msg}`;
    }

    info(msg)  { console.log(this._fmt('INFO', msg)); }
    error(msg) { console.error(this._fmt('ERROR', msg)); }
    warn(msg)  { console.warn(this._fmt('WARN', msg)); }
    debug(msg) { console.debug(this._fmt('DEBUG', msg)); }
}

// ── Message Queue ───────────────────────────────
// Promise-based queue with timeout for request-response matching
class MessageQueue extends EventEmitter {
    constructor(timeoutMs = QUEUE_TIMEOUT_MS) {
        super();
        this.messages = [];
        this.waiters = [];
        this.defaultTimeout = timeoutMs;
        this.closed = false;
    }

    enqueue(message) {
        if (this.closed) return;
        if (this.waiters.length > 0) {
            const waiter = this.waiters.shift();
            clearTimeout(waiter.timerId);
            waiter.resolve(message);
        } else {
            this.messages.push(message);
        }
    }

    async dequeue(timeoutMs = this.defaultTimeout) {
        if (this.closed) throw new Error('Queue closed');
        if (this.messages.length > 0) return this.messages.shift();

        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject };
            this.waiters.push(waiter);

            waiter.timerId = setTimeout(() => {
                const idx = this.waiters.indexOf(waiter);
                if (idx !== -1) {
                    this.waiters.splice(idx, 1);
                    reject(new Error('Queue timeout'));
                }
            }, timeoutMs);
        });
    }

    close() {
        this.closed = true;
        for (const waiter of this.waiters) {
            clearTimeout(waiter.timerId);
            waiter.reject(new Error('Queue closed'));
        }
        this.waiters = [];
        this.messages = [];
    }
}

// ── Connection Registry ─────────────────────────
// Manages browser proxy WebSocket connections
class ConnectionRegistry extends EventEmitter {
    constructor(logger) {
        super();
        this.logger = logger;
        this.connections = new Set();
        this.queues = new Map();
        this.roundRobinIdx = 0;
    }

    addConnection(ws, info) {
        this.connections.add(ws);
        this.logger.info(`Browser proxy connected: ${info.address}`);

        ws.on('message', (data) => this._handleMessage(data.toString()));
        ws.on('close', () => this._removeConnection(ws));
        ws.on('error', (err) => this.logger.error(`WS error: ${err.message}`));

        this.emit('connectionAdded', ws);
    }

    _removeConnection(ws) {
        this.connections.delete(ws);
        this.logger.info('Browser proxy disconnected');

        // Close all pending queues — the proxy is gone
        for (const queue of this.queues.values()) queue.close();
        this.queues.clear();

        this.emit('connectionRemoved', ws);
    }

    _handleMessage(data) {
        try {
            const msg = JSON.parse(data);
            const reqId = msg.request_id;

            if (!reqId) {
                this.logger.warn('Message without request_id received');
                return;
            }

            const queue = this.queues.get(reqId);
            if (!queue) {
                this.logger.warn(`Unknown request_id: ${reqId}`);
                return;
            }

            switch (msg.event_type) {
                case 'response_headers':
                case 'chunk':
                case 'error':
                    queue.enqueue(msg);
                    break;
                case 'stream_close':
                    queue.enqueue({ type: 'STREAM_END' });
                    break;
                default:
                    this.logger.warn(`Unknown event_type: ${msg.event_type}`);
            }
        } catch {
            this.logger.error('Failed to parse WS message');
        }
    }

    hasConnections() { return this.connections.size > 0; }

    // Round-robin connection selection for load distribution
    selectConnection() {
        const conns = [...this.connections].filter(ws => ws.readyState === WebSocket.OPEN);
        if (conns.length === 0) return null;
        if (conns.length === 1) return conns[0];
        this.roundRobinIdx = (this.roundRobinIdx + 1) % conns.length;
        return conns[this.roundRobinIdx];
    }

    createQueue(requestId) {
        const queue = new MessageQueue();
        this.queues.set(requestId, queue);
        return queue;
    }

    removeQueue(requestId) {
        const queue = this.queues.get(requestId);
        if (queue) { queue.close(); this.queues.delete(requestId); }
    }
}

// ── AI Processing ───────────────────────────────
// Empty return fix — extracted from build-反代 research
function rand64() { return randomBytes(32).toString('hex'); }

function normRole(r) {
    if (r === 'assistant' || r === 'model') return 'model';
    if (r === 'user') return 'user';
    return r || '';
}

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

function processBody(body) {
    if (!body || !EMPTY_RETURN_FIX_ENABLED) return body;
    try {
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed.messages)) {
            const original = parsed.messages.length;
            parsed.messages = applyEmptyReturnFix(parsed.messages);
            if (parsed.messages.length !== original) {
                console.log(`[AI] Empty return fix: ${original} → ${parsed.messages.length} messages`);
                return JSON.stringify(parsed);
            }
        }
    } catch { /* not JSON */ }
    return body;
}

// ── Request Handler ─────────────────────────────
class RequestHandler {
    constructor(registry, logger) {
        this.registry = registry;
        this.logger = logger;
    }

    async processRequest(req, res) {
        this.logger.info(`${req.method} ${req.url}`);

        if (!this.registry.hasConnections()) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No browser proxy connected', code: 503 } }));
            return;
        }

        const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

        // Collect request body
        const bodyChunks = [];
        let bodySize = 0;

        for await (const chunk of req) {
            bodySize += chunk.length;
            if (bodySize > MAX_BODY_SIZE) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Request body too large', code: 413 } }));
                return;
            }
            bodyChunks.push(chunk);
        }

        let body = Buffer.concat(bodyChunks).toString();

        // Apply AI processing
        body = processBody(body);

        const proxyReq = {
            path: req.url,
            method: req.method,
            headers: req.headers,
            query_params: {},
            body: body || '',
            request_id: requestId
        };

        const queue = this.registry.createQueue(requestId);
        let clientDisconnected = false;

        // Handle client disconnect
        req.on('close', () => {
            if (!res.writableEnded) {
                clientDisconnected = true;
                this.registry.removeQueue(requestId);
            }
        });

        try {
            const connection = this.registry.selectConnection();
            if (!connection) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'No active proxy connection', code: 503 } }));
                return;
            }

            connection.send(JSON.stringify(proxyReq));

            // Wait for response headers
            const headerMsg = await queue.dequeue();

            if (clientDisconnected) return;

            if (headerMsg.event_type === 'error') {
                res.writeHead(headerMsg.status || 500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: headerMsg.message, code: headerMsg.status } }));
                return;
            }

            // Set response headers
            res.writeHead(headerMsg.status || 200, headerMsg.headers || {});

            // Stream data chunks
            while (true) {
                try {
                    const dataMsg = await queue.dequeue();
                    if (clientDisconnected) break;
                    if (dataMsg.type === 'STREAM_END') break;
                    if (dataMsg.data) res.write(dataMsg.data);
                } catch (err) {
                    if (err.message === 'Queue timeout') {
                        const ct = res.getHeader('Content-Type') || '';
                        if (ct.includes('text/event-stream')) {
                            res.write(': keepalive\n\n');
                        } else {
                            break;
                        }
                    } else {
                        throw err;
                    }
                }
            }

            res.end();
        } catch (err) {
            if (clientDisconnected) return;
            if (err.message === 'Queue timeout') {
                res.writeHead(504, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Request timeout', code: 504 } }));
            } else if (err.message === 'Queue closed') {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Proxy connection lost', code: 502 } }));
            } else {
                this.logger.error(`Request error: ${err.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `Proxy error: ${err.message}`, code: 500 } }));
            }
        } finally {
            this.registry.removeQueue(requestId);
        }
    }
}

// ── Main Server ─────────────────────────────────
class ProxyServer extends EventEmitter {
    constructor(config = {}) {
        super();
        this.config = {
            httpPort: HTTP_PORT,
            wsPort: WS_PORT,
            host: HOST,
            ...config
        };

        this.logger = new Logger('ProxyServer');
        this.registry = new ConnectionRegistry(this.logger);
        this.handler = new RequestHandler(this.registry, this.logger);
    }

    async start() {
        try {
            await this._startHttp();
            await this._startWs();
            this.logger.info('Proxy server system started');
            this.emit('started');
        } catch (err) {
            this.logger.error(`Start failed: ${err.message}`);
            this.emit('error', err);
            throw err;
        }
    }

    async _startHttp() {
        this.httpServer = createServer(async (req, res) => {
            // CORS
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', '*');

            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }

            // Health check
            if (req.url === '/health' || req.url === '/') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'ok',
                    version: '2.0.0',
                    connections: this.registry.connections.size,
                    queues: this.registry.queues.size,
                    emptyReturnFix: EMPTY_RETURN_FIX_ENABLED,
                }));
                return;
            }

            await this.handler.processRequest(req, res);
        });

        return new Promise((resolve) => {
            this.httpServer.listen(this.config.httpPort, this.config.host, () => {
                this.logger.info(`HTTP → http://${this.config.host}:${this.config.httpPort}`);
                resolve();
            });
        });
    }

    async _startWs() {
        this.wsServer = new WebSocketServer({
            port: this.config.wsPort,
            host: this.config.host,
        });

        this.wsServer.on('connection', (ws, req) => {
            this.registry.addConnection(ws, { address: req.socket.remoteAddress });
        });

        this.logger.info(`WS  → ws://${this.config.host}:${this.config.wsPort}`);
    }
}

// ── Start ───────────────────────────────────────
const server = new ProxyServer();
server.start().catch((err) => {
    console.error('Server start failed:', err.message);
    process.exit(1);
});

export { ProxyServer };
