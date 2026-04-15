# 🎮 Hướng Dẫn Kết Nối SillyTavern với AI Gemini (Miễn Phí)

> Dùng AI Gemini miễn phí trên SillyTavern thông qua WS Relay Bridge.
> Không cần cài thêm phần mềm, không cần API key trả phí.

---

## 📋 Yêu Cầu

| Thứ | Chi tiết |
|-----|----------|
| **SillyTavern** | Phiên bản 1.12+ (bất kỳ nền tảng) |
| **Chủ proxy** | Cần 1 người chạy AI Studio Proxy App và giữ tab mở |
| **Người dùng** | Chỉ cần SillyTavern + URL relay |

---

## 🚀 Cách Cấu Hình (Cho Người Dùng SillyTavern)

### Bước 1: Mở API Settings

Trong SillyTavern, nhấn vào biểu tượng ⚡ **API Connections** (góc trên).

### Bước 2: Chọn loại API

| Mục | Chọn |
|-----|------|
| **API** | `Chat Completion` |
| **Nguồn cho Chat Completion** | `Custom (OpenAI-compatible)` |

### Bước 3: Điền thông tin

| Mục | Giá trị |
|-----|---------|
| **Đường link custom (Base URL)** | `https://ws-relay-qcfy.onrender.com/api/ROOM_CODE` |
| **Key API** | Nhập bất kỳ (ví dụ: `abc123`) |
| **Model ID** | Xem bảng model bên dưới |

> ⚠️ **Thay `ROOM_CODE`** bằng mã phòng mà chủ proxy chia sẻ cho bạn.
>
> Ví dụ: `https://ws-relay-qcfy.onrender.com/api/mariengban`

### Bước 4: Chọn Model

Gõ chính xác tên model vào ô **"Enter a Model ID"**:

| Model | Tên điền | Ghi chú |
|-------|----------|---------|
| Gemini 2.0 Flash | `gemini-2.0-flash` | Nhanh, ổn định, khuyên dùng |
| Gemini 2.5 Flash | `gemini-2.5-flash-preview-04-17` | Nhanh, thông minh hơn |
| Gemini 2.5 Pro | `gemini-2.5-pro-preview-05-06` | Chất lượng cao nhất |

### Bước 5: Cài đặt quan trọng

Điều chỉnh các thông số sau để có chất lượng tốt nhất:

| Thông số | Giá trị khuyên dùng | Ở đâu |
|----------|---------------------|-------|
| **Max Response Length** | `4096` | Thanh trượt trong settings |
| **Temperature** | `0.8 ~ 1.0` | Settings → Sampling |
| **Top P** | `0.95` | Settings → Sampling |
| **Streaming** | ✅ Bật | API Settings |

### Bước 6: Kết nối

Nhấn nút **"Kết nối"** hoặc **"Connect"**.

- ✅ **Xanh "Valid"** = Thành công!
- ❌ **Đỏ lỗi** = Xem phần Xử Lý Lỗi bên dưới.

---

## 🔍 Kiểm Tra Trạng Thái

Mở link sau trên trình duyệt để kiểm tra:

```
https://ws-relay-qcfy.onrender.com/status/ROOM_CODE
```

| Trường | Ý nghĩa |
|--------|---------|
| `"proxyConnected": true` | ✅ Proxy đang hoạt động, dùng được |
| `"proxyConnected": false` | ❌ Chủ proxy chưa mở app, chờ họ kết nối |

---

## ⚠️ Xử Lý Lỗi Thường Gặp

### "Request contains an invalid argument"
- **Nguyên nhân**: Tham số không tương thích
- **Cách sửa**: Vào **Additional Parameters** → xóa hết các tham số lạ. Chỉ giữ `temperature`, `max_tokens`, `top_p`

### "Requested entity was not found"
- **Nguyên nhân**: Tên model sai
- **Cách sửa**: Kiểm tra lại tên model (phải gõ chính xác)

### "503 - No proxy connected"
- **Nguyên nhân**: Chủ proxy chưa mở app
- **Cách sửa**: Liên hệ chủ proxy bật app, kiểm tra tại `/status/ROOM_CODE`

### Không có phản hồi / treo
- **Nguyên nhân**: Relay server trên Render đang ngủ (free tier)
- **Cách sửa**: Đợi 30-60 giây, gửi lại. Lần đầu sau khi server ngủ sẽ chậm

### Phản hồi quá ngắn (1 dòng)
- **Nguyên nhân**: `Max Response Length` quá thấp
- **Cách sửa**: Tăng lên `2048` hoặc `4096`

---

## 🏗️ Cách Hoạt Động

```
┌─────────────┐     HTTP      ┌──────────────┐      WS       ┌──────────────┐
│ SillyTavern │ ──────────▶  │  WS Relay    │ ──────────▶  │  Proxy App   │
│ (người dùng)│              │  Bridge      │              │  (chủ proxy) │
└─────────────┘              └──────────────┘              └──────────────┘
                                                                  │
                                                                  ▼
                                                           ┌──────────────┐
                                                           │  Google      │
                                                           │  Gemini API  │
                                                           └──────────────┘
```

1. **SillyTavern** gửi request HTTP tới relay bridge
2. **Relay Bridge** chuyển request qua WebSocket tới proxy app
3. **Proxy App** gọi Google Gemini API (dùng token miễn phí)
4. **Response** quay ngược lại: Gemini → Proxy → Relay → SillyTavern

---

## 👑 Hướng Dẫn Cho Chủ Proxy

Nếu bạn muốn **host proxy cho người khác dùng**:

### 1. Mở AI Studio Proxy App
- Truy cập app tại link Remix / URL được cung cấp
- Nhập room code (ví dụ: `mariengban`)
- Nhấn **"Kết nối"** → đợi trạng thái **"Đã kết nối"** (xanh)

### 2. Import JSON xác thực
- Nhấn **"Nhập JSON"** → paste cookies từ AI Studio
- Hoặc nhấn **"Lấy thông tin"** nếu đã đăng nhập

### 3. Giữ tab mở
- **KHÔNG đóng tab** proxy app khi người khác đang dùng
- Bật **"Tự động làm mới Token"** để duy trì phiên
- Trên mobile: bật **"Giữ hoạt động trên mobile"**

### 4. Chia sẻ cho người dùng
Gửi cho họ:
```
URL: https://ws-relay-qcfy.onrender.com/api/ROOM_CODE_CUA_BAN
```

> 💡 **Mẹo**: Dùng room code khó đoán (ví dụ: `mygroup-2026-secret`) để tránh người lạ dùng.

---

## 📝 Lưu Ý Quan Trọng

- 🕐 **Render Free Tier**: Server ngủ sau 15 phút không dùng. Request đầu tiên sau khi ngủ sẽ chậm 30-60s.
- 🔑 **Không cần API key Google**: Proxy app dùng token miễn phí từ AI Studio.
- 📱 **Dùng trên điện thoại**: SillyTavern mobile hoạt động bình thường.
- 🔒 **Bảo mật**: Room code là "mật khẩu" duy nhất. Ai biết room code đều có thể gửi request qua proxy của bạn.

---

## 💬 Hỗ Trợ

Nếu gặp vấn đề:
1. Kiểm tra `/status/ROOM_CODE` trước
2. Thử đổi model sang `gemini-2.0-flash`
3. Chờ 1-2 phút nếu vừa kết nối lần đầu
4. Liên hệ chủ proxy nếu status hiện `proxyConnected: false`
