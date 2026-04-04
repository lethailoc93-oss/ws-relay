# Prompt cho AI Studio — Cập nhật Proxy App tương thích Relay v2.0

## Hướng dẫn sử dụng

1. Mở app trên AI Studio: https://aistudio.google.com
2. Vào app proxy của bạn (Remix app v1.1)
3. Copy toàn bộ nội dung phần **"PROMPT"** bên dưới
4. Paste vào ô chat của AI Studio
5. Nhấn Enter để AI xử lý
6. Review changes → nhấn "Checkpoint" nếu OK

---

## PROMPT

```
Cập nhật code phần kết nối WebSocket để tương thích với ws-relay-server v2.0.0. Có 3 thay đổi cần làm:

### 1. Thêm `&role=proxy` vào URL kết nối WebSocket

Tìm chỗ code tạo WebSocket connection tới relay server. Khi build URL, thêm query param `role=proxy`.

Ví dụ:
- Trước: `new WebSocket("wss://example.com?code=abc")`  
- Sau: `new WebSocket("wss://example.com?code=abc&role=proxy")`

Cách thêm an toàn:
```javascript
// Nếu URL đã có dạng string, append role param:
function addRoleParam(wsUrl) {
    try {
        const url = new URL(wsUrl);
        if (!url.searchParams.has('role')) {
            url.searchParams.set('role', 'proxy');
        }
        return url.toString();
    } catch {
        const sep = wsUrl.includes('?') ? '&' : '?';
        return wsUrl.includes('role=') ? wsUrl : wsUrl + sep + 'role=proxy';
    }
}

// Sử dụng khi connect:
// const ws = new WebSocket(addRoleParam(relayUrl));
```

### 2. Lọc message `server_info` từ relay server

Ngay sau khi kết nối thành công, relay server v2 sẽ gửi một message JSON đặc biệt:
```json
{
    "event_type": "server_info",
    "version": "2.0.0",
    "capabilities": ["batch", "compression", "role_pairing"],
    "assigned_role": "proxy",
    "client_id": "abc123"
}
```

Trong hàm xử lý `ws.onmessage` hoặc `ws.addEventListener('message', ...)`, thêm check ở ĐẦU hàm:

```javascript
// Ở đầu message handler, TRƯỚC khi xử lý message bình thường:
const parsed = JSON.parse(event.data);

// Bỏ qua server_info — đây là message hệ thống từ relay, không phải request từ app
if (parsed.event_type === 'server_info') {
    console.log(`[Relay] Connected to relay v${parsed.version}, role=${parsed.assigned_role}`);
    return; // KHÔNG xử lý tiếp, KHÔNG forward
}
```

### 3. Xử lý batch message

Relay server v2 có thể gộp nhiều message thành 1 batch để tiết kiệm bandwidth. Thêm check sau `server_info`:

```javascript
// Xử lý batch: relay gộp nhiều request vào 1 message
if (parsed.event_type === 'batch' && Array.isArray(parsed.items)) {
    for (const item of parsed.items) {
        const msg = typeof item === 'string' ? JSON.parse(item) : item;
        handleSingleMessage(msg); // gọi hàm xử lý message đơn lẻ hiện tại
    }
    return;
}
```

Nếu code hiện tại xử lý message trong cùng 1 hàm (không tách riêng), hãy refactor: tách logic xử lý 1 message ra thành hàm riêng `handleSingleMessage(parsed)`, rồi:
- Message bình thường → gọi `handleSingleMessage(parsed)`
- Batch message → loop `parsed.items` và gọi `handleSingleMessage(item)` cho mỗi item

### Tóm tắt flow sau khi sửa:

```
ws.onmessage = (event) => {
    const parsed = JSON.parse(event.data);
    
    // 1. Skip server info
    if (parsed.event_type === 'server_info') {
        console.log('[Relay] v' + parsed.version + ' connected');
        return;
    }
    
    // 2. Handle batch
    if (parsed.event_type === 'batch' && Array.isArray(parsed.items)) {
        parsed.items.forEach(item => {
            handleSingleMessage(typeof item === 'string' ? JSON.parse(item) : item);
        });
        return;
    }
    
    // 3. Handle single message (logic hiện tại)
    handleSingleMessage(parsed);
};
```

### QUAN TRỌNG — KHÔNG thay đổi:
- Logic gửi response (response_headers, chunk, stream_close, error) — giữ nguyên
- Logic gọi Gemini API — giữ nguyên  
- Giao diện UI — giữ nguyên
- Flow xác thực / credentials — giữ nguyên
- Chỉ sửa 3 điểm trên
```
