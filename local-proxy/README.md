# Local Proxy cho SillyTavern (Qua Google AI Studio)

Đây là công cụ giúp bạn dùng Google Gemini trong SillyTavern hoàn toàn miễn phí, tốc độ cao và **không cần API Key**. Nó sử dụng chính trình duyệt của bạn (đã đăng nhập Google) làm cầu nối.

## Cần chuẩn bị
1. Cài đặt [Node.js](https://nodejs.org/) (ưu tiên bản LTS).
2. Trình duyệt web (Chrome, Edge, Cốc Cốc...)

---

## Cách sử dụng (Chỉ 3 bước)

### Bước 1: Khởi động Server trung gian
1. Mở thư mục chứa file `dark-server.js`.
2. Mở Terminal / Command Prompt tại thư mục này (gõ `cmd` lên thanh địa chỉ của File Explorer rồi Enter).
3. Chạy lệnh:
   ```bash
   node dark-server.js
   ```
4. Nếu thấy báo `[ProxyServer] Proxy server system started`, hãy cứ để cửa sổ đó mở (không tắt).

### Bước 2: Kết nối Trình duyệt
1. Mở trình duyệt và truy cập [Google AI Studio](https://aistudio.google.com). Hãy chắc chắn bạn đã đăng nhập tài khoản Google.
2. Ấn phím `F12` (hoặc chuột phải -> Kiểm tra / Inspect) để mở **Developer Tools**.
3. Chuyển sang tab **Console**.
4. Mở file `dark-browser.js` bằng Notepad. Copy **toàn bộ nội dung** trong đó.
5. Paste vào **Console** của trình duyệt và nhấn `Enter`.
6. Nếu thấy báo `✅ Browser proxy agent started` và `[Connection] Connected`, bạn đã thành công! Cứ để tab Google Studio đó mở.

### Bước 3: Cấu hình trong SillyTavern
1. Mở SillyTavern.
2. Vào biểu tượng phích cắm (API Connections).
3. Chỉnh các thông số sau:
   - **API:** `Chat Completion` (hoặc OpenAI Compatible)
   - **Chat Completion Source:** `Custom (OpenAI-compatible)`
   - **API URL:** `http://127.0.0.1:8889`
   - **API Key:** Điền bừa 1 số bất kỳ (ví dụ: `123`)
4. Bấm **Connect**.
5. Kéo xuống mục **Model**, gõ tên model bạn muốn dùng (ví dụ: `gemini-2.5-flash` hoặc `gemini-2.5-pro`) và tích vào ô `✔`.

---

## 💡 Mẹo nhỏ cho lần sau
Khi muốn chơi lại, bạn chỉ cần lặp lại 3 bước trên:
1. Chạy `node dark-server.js`
2. Mở tab Google AI Studio, paste code của `dark-browser.js` vào Console (bạn có thể lưu code đó ra note để paste cho lẹ).
3. Bật SillyTavern và chơi (Cấu hình ST đã được tự động lưu từ lần trước).
