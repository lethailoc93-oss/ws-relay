// Minimal integration test for v2 relay
import WebSocket from 'ws';

const ws_url = 'ws://localhost:8080';
const wait = ms => new Promise(r => setTimeout(r, ms));

async function test() {
    console.log('--- Test: Role-based routing ---');
    
    // 1. Connect app
    const app = new WebSocket(`${ws_url}?code=room1&role=app`);
    await new Promise(r => app.on('open', r));
    
    // Wait for server_info
    const info = await new Promise(r => {
        app.on('message', (d) => {
            const m = JSON.parse(d.toString());
            if (m.event_type === 'server_info') r(m);
        });
    });
    console.log(`✅ Server info: v${info.version}, role=${info.assigned_role}, caps=[${info.capabilities}]`);
    
    // 2. Connect proxy
    const proxy = new WebSocket(`${ws_url}?code=room1&role=proxy`);
    await new Promise(r => proxy.on('open', r));
    // drain server_info
    await new Promise(r => {
        proxy.on('message', (d) => {
            const m = JSON.parse(d.toString());
            if (m.event_type === 'server_info') r(m);
        });
    });
    console.log('✅ Proxy connected');
    
    // 3. App → Proxy routing
    const proxyGot = new Promise(r => {
        proxy.on('message', (d) => {
            const m = JSON.parse(d.toString());
            if (m.request_id) r(m);
        });
    });
    app.send(JSON.stringify({ request_id: 'r1', method: 'POST', path: '/v1beta/test', body: '{"hello":"world"}' }));
    const req = await proxyGot;
    console.log(`✅ Proxy received: ${req.method} ${req.path} (id=${req.request_id})`);
    
    // 4. Proxy → App routing (simulate response)
    const appGot = new Promise(r => {
        app.on('message', (d) => {
            const m = JSON.parse(d.toString());
            if (m.request_id) r(m);
        });
    });
    proxy.send(JSON.stringify({ request_id: 'r1', event_type: 'stream_close', status: 200 }));
    const resp = await appGot;
    console.log(`✅ App received: event=${resp.event_type}, status=${resp.status}`);
    
    // 5. Check health metrics
    const health = await fetch('http://localhost:8080/health').then(r => r.json());
    console.log(`✅ Metrics: ${health.metrics.messagesRelayed} msgs relayed, ${health.metrics.bytesRelayed} bytes`);
    console.log(`   Rooms: ${health.rooms}, Connections: ${health.connections}`);
    
    app.close();
    proxy.close();
    
    await wait(300);
    console.log('\n🎉 All tests passed!');
    process.exit(0);
}

test().catch(e => { console.error('❌ FAIL:', e.message); process.exit(1); });
