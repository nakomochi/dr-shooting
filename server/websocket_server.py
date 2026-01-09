"""
FastSAM WebSocket Server for Quest3 VR
Tailscale経由で接続可能
"""
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import FastSAM
import base64
import json
import numpy as np
from PIL import Image
from io import BytesIO
import asyncio
from datetime import datetime

app = FastAPI(title="FastSAM WebSocket Server")

# CORS設定（必要に応じて）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# FastSAMモデルをロード
print("Loading FastSAM model...")
model = FastSAM("FastSAM-s.pt")
print("FastSAM model loaded successfully!")


@app.get("/")
async def root():
    """ヘルスチェック用エンドポイント"""
    return {
        "status": "running",
        "service": "FastSAM WebSocket Server",
        "endpoint": "ws://[YOUR_TAILSCALE_IP]:8000/ws"
    }


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    WebSocketエンドポイント
    Unity側から画像を受信し、セグメンテーション結果を返す
    """
    await websocket.accept()
    print(f"Client connected: {websocket.client}")
    
    try:
        while True:
            # Unity側からメッセージを受信
            data = await websocket.receive_text()
            start_time = datetime.now()
            
            try:
                message = json.loads(data)
                
                # 画像データを取得
                if "image" not in message:
                    await websocket.send_text(json.dumps({
                        "error": "No image data provided"
                    }))
                    continue
                
                # Base64エンコードされた画像をデコード
                image_data = base64.b64decode(message["image"])
                image = Image.open(BytesIO(image_data))
                
                # パラメータを取得（デフォルト値あり）
                conf_threshold = message.get("conf", 0.4)
                iou_threshold = message.get("iou", 0.9)
                max_masks = message.get("max_masks", 10)
                
                print(f"Processing image: {image.size}, conf={conf_threshold}, iou={iou_threshold}")
                
                # FastSAMで推論
                results = model(
                    image,
                    device="cpu",
                    retina_masks=True,
                    imgsz=640,  # Quest3向けに少し小さめ
                    conf=conf_threshold,
                    iou=iou_threshold,
                )
                
                # マスクデータを抽出
                if results[0].masks is not None:
                    masks = results[0].masks.data.cpu().numpy()
                    mask_count = len(masks)
                    
                    # マスクを制限
                    masks = masks[:max_masks]
                    
                    # マスクをBase64エンコード（サイズ削減のため圧縮）
                    masks_data = []
                    for i, mask in enumerate(masks):
                        # マスクをバイナリ化（0 or 255）
                        binary_mask = (mask > 0.5).astype(np.uint8) * 255
                        
                        # PNGとして圧縮
                        mask_img = Image.fromarray(binary_mask)
                        buffered = BytesIO()
                        mask_img.save(buffered, format="PNG", optimize=True)
                        mask_base64 = base64.b64encode(buffered.getvalue()).decode()
                        
                        masks_data.append({
                            "id": i,
                            "data": mask_base64,
                            "width": int(mask.shape[1]),
                            "height": int(mask.shape[0])
                        })
                    
                    processing_time = (datetime.now() - start_time).total_seconds()
                    
                    # レスポンスを送信
                    response = {
                        "success": True,
                        "count": mask_count,
                        "masks": masks_data,
                        "processing_time": processing_time,
                        "image_size": list(image.size)
                    }
                    
                    print(f"Sent {len(masks_data)} masks (total: {mask_count}) in {processing_time:.3f}s")
                    
                else:
                    response = {
                        "success": True,
                        "count": 0,
                        "masks": [],
                        "message": "No segments detected"
                    }
                
                await websocket.send_text(json.dumps(response))
                
            except json.JSONDecodeError:
                await websocket.send_text(json.dumps({
                    "error": "Invalid JSON format"
                }))
            except Exception as e:
                print(f"Error processing image: {e}")
                await websocket.send_text(json.dumps({
                    "error": str(e)
                }))
    
    except WebSocketDisconnect:
        print(f"Client disconnected: {websocket.client}")
    except Exception as e:
        print(f"WebSocket error: {e}")


if __name__ == "__main__":
    import uvicorn
    
    print("\n" + "="*60)
    print("FastSAM WebSocket Server")
    print("="*60)
    print("\nStarting server on 0.0.0.0:8000")
    print("\nTailscale接続:")
    print("  1. PC側でTailscaleを起動")
    print("  2. Quest3でもTailscaleを起動")
    print("  3. Unity側で ws://[PC_TAILSCALE_IP]:8000/ws に接続")
    print("\nTailscale IPを確認: tailscale ip")
    print("="*60 + "\n")
    
    uvicorn.run(
        app,
        host="0.0.0.0",  # すべてのインターフェースでリッスン
        port=8000,
        log_level="info"
    )
