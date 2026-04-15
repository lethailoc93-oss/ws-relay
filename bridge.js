#!/usr/bin/env node
// ================================================
// HTTP-to-WebSocket Bridge for SillyTavern
// Nhận HTTP request → chuyển qua WS Relay → Proxy App → Gemini API
//
// Cách dùng:
//   node bridge.js
//   → Server chạy tại http://localhost:5001
//   → SillyTavern trỏ Custom OpenAI URL: http://localhost:5001
//
// Yêu cầu:
//   1. AI Studio Proxy App đang mở và kết nối WS Relay
//   2. Proxy App và Bridge dùng CÙNG room code
// ================================================

const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

// ── Config ──────────────────────────────────────
const PORT = parseInt(process.env.BRIDGE_PORT || '5001');
const WS_RELAY = process.env.WS_RELAY || 'wss://ws-relay-qcfy.onrender.com';
const ROOM_CODE = process.env.ROOM_CODE || 'mariengban';
const HEARTBEAT_MS = 15000;

// ── State ───────────────────────────────────────
let ws = null;
let connected = false;
let serverInfo = null;
const pendingRequests = new Map(); // request_id → { res, chunks, headersSent }

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ── WebSocket Connection ────────────────────────
function connectWS() {
  const url = `${WS_RELAY}?code=${ROOM_CODE}&role=app`;
  log(`🔌 Connecting to ${url}`);

  ws = new WebSocket(url);

  ws.on('open', () => {
    connected = true;
    log('✅ WS Connected');
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Server info
      if (msg.event_type === 'server_info') {
        serverInfo = msg;
        log(`📡 Relay v${msg.version}, role=${msg.assigned_role}`);
        return;
      }

      // Heartbeat pong
      if (msg.event_type === 'pong' || msg.event_type === 'heartbeat') return;

      // Error from relay (no proxy)
      if (msg.event_type === 'error' && !msg.request_id) {
        log(`⚠️ Relay error: ${msg.message}`);
        return;
      }

      // Route to pending request
      const req = pendingRequests.get(msg.request_id);
      if (!req) return;

      switch (msg.event_type) {
        case 'response_headers':
          req.status = msg.status || 200;
          req.respHeaders = msg.headers || {};
          break;

        case 'chunk':
          if (!req.headersSent) {
            req.headersSent = true;
            const h = {
              'Content-Type': req.respHeaders['content-type'] || 'application/json',
              'Transfer-Encoding': 'chunked',
              'Access-Control-Allow-Origin': '*',
            };
            req.res.writeHead(req.status || 200, h);
          }
          req.res.write(msg.data);
          break;

        case 'stream_close':
          if (!req.headersSent) {
            req.res.writeHead(req.status || 200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            });
          }
          req.res.end();
          pendingRequests.delete(msg.request_id);
          log(`✅ ${msg.request_id.slice(0, 8)} completed`);
          break;

        case 'error':
          if (!req.headersSent) {
            req.res.writeHead(msg.status || 500, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            });
          }
          req.res.end(JSON.stringify({ error: { message: msg.message, code: msg.status } }));
          pendingRequests.delete(msg.request_id);
          log(`❌ ${msg.request_id.slice(0, 8)} error: ${msg.message}`);
          break;
      }
    } catch (e) {
      // ignore parse errors
    }
  });

  ws.on('close', (code) => {
    connected = false;
    log(`🔴 WS Closed (${code}). Reconnecting in 5s...`);
    setTimeout(connectWS, 5000);
  });

  ws.on('error', (err) => {
    log(`❌ WS Error: ${err.message}`);
  });
}

// Heartbeat
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ event_type: 'heartbeat', ts: Date.now() }));
  }
}, HEARTBEAT_MS);

// ── HTTP Server ─────────────────────────────────
const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  // Health check
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      status: 'ok',
      wsConnected: connected,
      relay: WS_RELAY,
      room: ROOM_CODE,
      pending: pendingRequests.size,
      serverInfo,
    }));
    return;
  }

  // Collect body
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: { message: 'Bridge chưa kết nối WS Relay. Đợi vài giây rồi thử lại.', code: 503 } }));
      return;
    }

    const requestId = crypto.randomUUID();
    const path = req.url; // e.g. /v1beta/models/gemini-2.0-flash:generateContent
    const headers = { ...req.headers };
    // Remove hop-by-hop headers
    delete headers.host;
    delete headers.connection;
    delete headers['content-length'];
    delete headers['transfer-encoding'];

    // Parse query params
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const queryParams = {};
    urlObj.searchParams.forEach((v, k) => queryParams[k] = v);

    const requestSpec = {
      request_id: requestId,
      method: req.method,
      path: urlObj.pathname,
      headers,
      body: body || null,
      query_params: queryParams,
    };

    // Store pending
    pendingRequests.set(requestId, {
      res,
      status: 200,
      respHeaders: {},
      headersSent: false,
    });

    // Send through WS
    ws.send(JSON.stringify(requestSpec));
    log(`📤 ${requestId.slice(0, 8)} → ${req.method} ${urlObj.pathname}`);

    // Timeout 5 min
    setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        const p = pendingRequests.get(requestId);
        if (!p.headersSent) {
          p.res.writeHead(504, { 'Content-Type': 'application/json' });
        }
        p.res.end(JSON.stringify({ error: { message: 'Request timeout (5 phút)', code: 504 } }));
        pendingRequests.delete(requestId);
        log(`⏰ ${requestId.slice(0, 8)} timeout`);
      }
    }, 5 * 60 * 1000);
  });
});

// ── Start ───────────────────────────────────────
server.listen(PORT, () => {
  log('='.repeat(50));
  log('🌉 HTTP-to-WS Bridge for SillyTavern');
  log(`📡 Relay: ${WS_RELAY} | Room: ${ROOM_CODE}`);
  log(`🌐 http://localhost:${PORT}`);
  log('');
  log('SillyTavern config:');
  log(`  API: "Custom (OpenAI-compatible)" hoặc "Google AI Studio"`);
  log(`  Base URL: http://localhost:${PORT}`);
  log(`  API Key: (nhập bất kỳ)`);
  log('='.repeat(50));
  connectWS();
});
