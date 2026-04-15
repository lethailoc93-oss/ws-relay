// ================================================
// Browser-side Proxy Agent
// Runs in browser dev console / extension context.
// Connects to dark-server.js via WebSocket,
// receives HTTP requests, fetches Google APIs,
// and streams responses back.
// ================================================

// ── Logger ──────────────────────────────────────
const Logger = {
    enabled: true,

    output(...messages) {
        if (!this.enabled) return;
        const ts = this._timestamp();
        const el = document.createElement('div');
        el.textContent = `[${ts}] ${messages.join(' ')}`;
        document.body.appendChild(el);
    },

    _timestamp() {
        const now = new Date();
        const time = now.toLocaleTimeString('zh-CN', { hour12: false });
        const ms = now.getMilliseconds().toString().padStart(3, '0');
        return `${time}.${ms}`;
    }
};

// ── Metrics ─────────────────────────────────────
const metrics = {
    requestsProcessed: 0,
    requestsFailed: 0,
    bytesReceived: 0,
    bytesSent: 0,
    startedAt: Date.now(),
};

// ── Connection Manager ──────────────────────────
class ConnectionManager extends EventTarget {
    constructor(endpoint = 'ws://127.0.0.1:9998') {
        super();
        this.endpoint = endpoint;
        this.socket = null;
        this.isConnected = false;
        this.reconnectDelay = 5000;
        this.maxReconnectAttempts = Infinity;
        this.reconnectAttempts = 0;
    }

    async connect() {
        if (this.isConnected) {
            Logger.output('[Connection] Already connected');
            return;
        }

        Logger.output('[Connection] Connecting to:', this.endpoint);

        return new Promise((resolve, reject) => {
            this.socket = new WebSocket(this.endpoint);

            this.socket.addEventListener('open', () => {
                this.isConnected = true;
                this.reconnectAttempts = 0;
                Logger.output('[Connection] Connected');
                this.dispatchEvent(new CustomEvent('connected'));
                resolve();
            });

            this.socket.addEventListener('close', () => {
                this.isConnected = false;
                Logger.output('[Connection] Disconnected, will reconnect');
                this.dispatchEvent(new CustomEvent('disconnected'));
                this._scheduleReconnect();
            });

            this.socket.addEventListener('error', (error) => {
                Logger.output('[Connection] Error:', error);
                this.dispatchEvent(new CustomEvent('error', { detail: error }));
                if (!this.isConnected) reject(error);
            });

            this.socket.addEventListener('message', (event) => {
                this.dispatchEvent(new CustomEvent('message', { detail: event.data }));
            });
        });
    }

    send(data) {
        if (!this.isConnected || !this.socket) {
            Logger.output('[Connection] Cannot send: not connected');
            return false;
        }
        const payload = JSON.stringify(data);
        this.socket.send(payload);
        metrics.bytesSent += payload.length;
        return true;
    }

    _scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            Logger.output('[Connection] Max reconnect attempts reached');
            return;
        }
        this.reconnectAttempts++;
        setTimeout(() => {
            Logger.output(`[Connection] Reconnect attempt ${this.reconnectAttempts}`);
            this.connect().catch(() => {});
        }, this.reconnectDelay);
    }
}

// ── Request Processor ───────────────────────────
class RequestProcessor {
    constructor() {
        this.activeOps = new Map();
        this.targetDomain = 'generativelanguage.googleapis.com';
    }

    async execute(requestSpec, opId) {
        Logger.output('[Request] Executing:', requestSpec.method, requestSpec.path);
        const startTime = Date.now();

        try {
            const controller = new AbortController();
            this.activeOps.set(opId, controller);

            const url = this._buildUrl(requestSpec);
            const config = this._buildConfig(requestSpec, controller.signal);
            const response = await this._fetchWithRetry(url, config);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const elapsed = Date.now() - startTime;
            Logger.output(`[Request] Success: ${response.status} in ${elapsed}ms`);
            metrics.requestsProcessed++;
            return response;
        } catch (error) {
            metrics.requestsFailed++;
            Logger.output('[Request] Failed:', error.message);
            throw error;
        } finally {
            this.activeOps.delete(opId);
        }
    }

    cancelOp(opId) {
        const ctrl = this.activeOps.get(opId);
        if (ctrl) {
            ctrl.abort();
            this.activeOps.delete(opId);
            Logger.output('[Request] Cancelled:', opId);
        }
    }

    cancelAll() {
        for (const [id, ctrl] of this.activeOps) {
            ctrl.abort();
            Logger.output('[Request] Cancelled:', id);
        }
        this.activeOps.clear();
    }

    // Retry logic with exponential backoff for transient failures
    async _fetchWithRetry(url, config, maxRetries = 2) {
        let lastError;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await fetch(url, config);
            } catch (err) {
                lastError = err;
                // Don't retry aborts or non-transient errors
                if (err.name === 'AbortError') throw err;
                if (attempt < maxRetries) {
                    const delay = Math.pow(2, attempt) * 500; // 500ms, 1000ms
                    Logger.output(`[Request] Retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        }
        throw lastError;
    }

    _buildUrl(spec) {
        const path = spec.path.startsWith('/') ? spec.path.slice(1) : spec.path;
        const params = new URLSearchParams(spec.query_params);
        const qs = params.toString();
        return `https://${this.targetDomain}/${path}${qs ? '?' + qs : ''}`;
    }

    _buildConfig(spec, signal) {
        const config = {
            method: spec.method,
            headers: this._sanitizeHeaders(spec.headers),
            signal
        };
        if (['POST', 'PUT', 'PATCH'].includes(spec.method) && spec.body) {
            config.body = spec.body;
        }
        return config;
    }

    // Extended forbidden headers list — matches research build patterns
    _sanitizeHeaders(headers) {
        const cleaned = { ...headers };
        const forbidden = [
            'host', 'connection', 'content-length', 'origin',
            'referer', 'user-agent', 'sec-fetch-mode',
            'sec-fetch-site', 'sec-fetch-dest', 'sec-ch-ua',
            'sec-ch-ua-mobile', 'sec-ch-ua-platform',
            'accept-encoding', 'transfer-encoding',
            'upgrade-insecure-requests', 'cache-control', 'pragma',
        ];
        for (const h of forbidden) delete cleaned[h];
        return cleaned;
    }
}

// ── Stream Handler ──────────────────────────────
class StreamHandler {
    constructor(connection) {
        this.connection = connection;
    }

    async processStream(response, opId) {
        Logger.output('[Stream] Processing response');

        this._sendHeaders(response, opId);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let totalBytes = 0;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    Logger.output(`[Stream] Complete: ${totalBytes} bytes`);
                    this._sendEnd(opId);
                    break;
                }

                const text = decoder.decode(value, { stream: true });
                totalBytes += value.length;
                metrics.bytesReceived += value.length;
                this._sendChunk(text, opId);
            }
        } catch (err) {
            Logger.output('[Stream] Error:', err.message);
            throw err;
        }
    }

    _sendHeaders(response, opId) {
        const headers = {};
        response.headers.forEach((v, k) => { headers[k] = v; });

        this.connection.send({
            request_id: opId,
            event_type: 'response_headers',
            status: response.status,
            headers
        });
        Logger.output('[Stream] Headers sent');
    }

    _sendChunk(chunk, opId) {
        this.connection.send({
            request_id: opId,
            event_type: 'chunk',
            data: chunk
        });
    }

    _sendEnd(opId) {
        this.connection.send({
            request_id: opId,
            event_type: 'stream_close'
        });
    }
}

// ── Proxy System ────────────────────────────────
class ProxySystem extends EventTarget {
    constructor(wsEndpoint) {
        super();
        this.connection = new ConnectionManager(wsEndpoint);
        this.processor = new RequestProcessor();
        this.stream = new StreamHandler(this.connection);

        this._setupHandlers();
    }

    async initialize() {
        Logger.output('[System] Initializing...');
        try {
            await this.connection.connect();
            Logger.output('[System] Ready');
            this.dispatchEvent(new CustomEvent('ready'));
        } catch (err) {
            Logger.output('[System] Init failed:', err.message);
            this.dispatchEvent(new CustomEvent('error', { detail: err }));
            throw err;
        }
    }

    _setupHandlers() {
        this.connection.addEventListener('message', (event) => {
            this._handleMessage(event.detail);
        });

        this.connection.addEventListener('disconnected', () => {
            this.processor.cancelAll();
        });
    }

    async _handleMessage(data) {
        let spec;
        try {
            spec = JSON.parse(data);
            Logger.output('[System] Request:', spec.method, spec.path);
            await this._processRequest(spec);
        } catch (err) {
            Logger.output('[System] Error:', err.message);
            this._sendError(err, spec?.request_id);
        }
    }

    async _processRequest(spec) {
        const opId = spec.request_id;
        try {
            const response = await this.processor.execute(spec, opId);
            await this.stream.processStream(response, opId);
        } catch (err) {
            if (err.name === 'AbortError') {
                Logger.output('[System] Request aborted');
            } else {
                this._sendError(err, opId);
            }
        }
    }

    _sendError(error, opId) {
        if (!opId) {
            Logger.output('[System] Cannot send error: no operation ID');
            return;
        }

        this.connection.send({
            request_id: opId,
            event_type: 'error',
            status: 500,
            message: `Proxy error: ${error.message || 'Unknown'}`
        });
        Logger.output('[System] Error response sent');
    }
}

// ── Start ───────────────────────────────────────
async function start() {
    const system = new ProxySystem();

    // Expose metrics for debugging
    window.__proxyMetrics = metrics;
    window.__proxySystem = system;

    try {
        await system.initialize();
        console.log('✅ Browser proxy agent started');
        console.log('   Metrics: window.__proxyMetrics');
    } catch (err) {
        console.error('❌ Proxy start failed:', err);
    }
}

start();
