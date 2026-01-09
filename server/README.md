# FastSAM WebSocket Server for Quest3

Tailscale経由でQuest3からFastSAMを使用するためのWebSocketサーバー

## セットアップ

### 1. 必要なパッケージをインストール

```bash
cd server
uv pip install fastapi uvicorn websockets python-multipart
```

### 2. Tailscaleのセットアップ

#### PC側
```bash
# Tailscaleをインストール（初回のみ）
# https://tailscale.com/download からダウンロード

# Tailscaleを起動
tailscale up

# IPアドレスを確認
tailscale ip -4
# 出力例: 100.100.100.50
```

#### Quest3側
1. Quest3のブラウザで https://tailscale.com/download にアクセス
2. Android APKをダウンロード＆インストール
3. Tailscaleアプリを起動してログイン
4. 同じTailscaleアカウントでログイン

### 3. サーバーを起動

```bash
cd server
python websocket_server.py
```

起動すると以下のように表示されます：
```
FastSAM WebSocket Server
============================================================

Starting server on 0.0.0.0:8000

Tailscale接続:
  1. PC側でTailscaleを起動
  2. Quest3でもTailscaleを起動
  3. Unity側で ws://[PC_TAILSCALE_IP]:8000/ws に接続

Tailscale IPを確認: tailscale ip
============================================================
```

## Unity側の設定

### 1. NativeWebSocketパッケージをインストール

Unity Package Managerで以下を追加：
```
https://github.com/endel/NativeWebSocket.git#upm
```

### 2. FastSAMClient.csを設定

1. `Assets/FastSAMClient.cs` を任意のGameObjectにアタッチ
2. Inspector で Server IP に PC の Tailscale IP を設定（例: `100.100.100.50`）
3. パラメータを調整（必要に応じて）

### 3. 使用例

```csharp
public class Example : MonoBehaviour
{
    public FastSAMClient client;
    public Camera vrCamera;
    
    void Start()
    {
        // イベントリスナーを登録
        client.OnSegmentationReceived += OnSegmentationResult;
    }
    
    void Update()
    {
        // ボタンを押したら画像を送信
        if (OVRInput.GetDown(OVRInput.Button.One))
        {
            client.CaptureAndSend(vrCamera);
        }
    }
    
    void OnSegmentationResult(FastSAMResponse response)
    {
        Debug.Log($"受信: {response.count} セグメント");
        
        // マスクデータを処理
        foreach (var mask in response.masks)
        {
            // Base64からテクスチャに変換
            byte[] pngData = Convert.FromBase64String(mask.data);
            Texture2D maskTexture = new Texture2D(2, 2);
            maskTexture.LoadImage(pngData);
            
            // マスクを使って何かする
            // 例: オブジェクトの位置を検出、ARエフェクトなど
        }
    }
}
```

## 通信フォーマット

### リクエスト (Unity → Server)
```json
{
    "image": "base64_encoded_jpeg",
    "conf": 0.4,
    "iou": 0.9,
    "max_masks": 10
}
```

### レスポンス (Server → Unity)
```json
{
    "success": true,
    "count": 5,
    "masks": [
        {
            "id": 0,
            "data": "base64_encoded_png",
            "width": 640,
            "height": 480
        }
    ],
    "processing_time": 0.234,
    "image_size": [640, 480]
}
```

## トラブルシューティング

### 接続できない場合

1. **Tailscaleが起動しているか確認**
   ```bash
   tailscale status
   ```

2. **IPアドレスが正しいか確認**
   ```bash
   tailscale ip -4
   ```

3. **ファイアウォールの確認**
   - Windows Defender でポート8000を許可

4. **サーバーが起動しているか確認**
   - ブラウザで `http://[TAILSCALE_IP]:8000` にアクセス
   - `{"status": "running", ...}` が表示されればOK

### パフォーマンスが悪い場合

1. **画像サイズを小さくする**
   ```csharp
   // FastSAMClient.cs の CaptureCamera内
   int width = 320;  // 640 → 320
   int height = 240; // 480 → 240
   ```

2. **max_masksを減らす**
   ```csharp
   public int maxMasks = 5;  // 10 → 5
   ```

3. **imgsz を小さくする（サーバー側）**
   ```python
   # websocket_server.py
   imgsz=512,  # 640 → 512
   ```

## 参考

- FastAPI WebSocket: https://fastapi.tiangolo.com/advanced/websockets/
- Tailscale: https://tailscale.com/kb/
- NativeWebSocket: https://github.com/endel/NativeWebSocket
