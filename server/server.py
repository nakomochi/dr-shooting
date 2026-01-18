"""
FastSAM WebSocket Server for Quest3 VR
Tailscale経由で接続可能
HTTP POST /segment エンドポイントも提供
"""
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from ultralytics import FastSAM
import base64
import json
import colorsys
import numpy as np
from PIL import Image
from io import BytesIO
import asyncio
from datetime import datetime


class SegmentRequest(BaseModel):
    """セグメンテーションリクエストのスキーマ"""
    image: str  # Base64 encoded
    conf: float = 0.4
    iou: float = 0.9
    max_masks: int = 20


def generate_distinct_color(index: int) -> list[int]:
    """黄金比を使って視覚的に区別しやすい色を生成"""
    golden_ratio = 0.618033988749895
    hue = (index * golden_ratio) % 1.0
    r, g, b = colorsys.hsv_to_rgb(hue, 0.7, 0.9)
    return [int(r * 255), int(g * 255), int(b * 255)]

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
        "endpoints": {
            "websocket": "ws://localhost:8000/ws",
            "http": "POST http://localhost:8000/segment"
        }
    }


@app.post("/segment")
async def segment_image(request: SegmentRequest):
    """
    HTTP POST エンドポイント: 画像をセグメンテーション
    WebXRからの一回限りのリクエスト用
    """
    start_time = datetime.now()

    try:
        # Base64デコード
        image_data = base64.b64decode(request.image)
        image = Image.open(BytesIO(image_data))

        print(f"[HTTP] Processing image: {image.size}, conf={request.conf}, iou={request.iou}")

        # FastSAMで推論
        results = model(
            image,
            device="cpu",
            retina_masks=True,
            imgsz=640,
            conf=request.conf,
            iou=request.iou,
        )

        masks_data = []
        if results[0].masks is not None:
            masks = results[0].masks.data.cpu().numpy()
            boxes = results[0].boxes.xyxy.cpu().numpy() if results[0].boxes is not None else None

            for i, mask in enumerate(masks[:request.max_masks]):
                # マスクをバイナリ化
                binary_mask = (mask > 0.5).astype(np.uint8) * 255

                # PNGとして圧縮
                mask_img = Image.fromarray(binary_mask)
                buffered = BytesIO()
                mask_img.save(buffered, format="PNG", optimize=True)
                mask_base64 = base64.b64encode(buffered.getvalue()).decode()

                # bounding box (存在する場合)
                bbox = boxes[i].tolist() if boxes is not None and i < len(boxes) else None

                masks_data.append({
                    "id": i,
                    "data": mask_base64,
                    "width": int(mask.shape[1]),
                    "height": int(mask.shape[0]),
                    "bbox": bbox,
                    "color": generate_distinct_color(i),
                })

        processing_time = (datetime.now() - start_time).total_seconds()

        print(f"[HTTP] Sent {len(masks_data)} masks in {processing_time:.3f}s")

        return {
            "success": True,
            "count": len(masks_data),
            "masks": masks_data,
            "processing_time": processing_time,
            "image_size": list(image.size)
        }

    except Exception as e:
        print(f"[HTTP] Error: {e}")
        return {
            "success": False,
            "error": str(e),
            "masks": []
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
    import os
    from pathlib import Path

    print("\n" + "="*60)
    print("FastSAM Segmentation Server (HTTPS)")
    print("="*60)
    print("\nStarting server on 0.0.0.0:8000")
    print("\nUSB-C接続 (Quest3):")
    print("  adb reverse tcp:8000 tcp:8000")
    print("  Quest3からは https://localhost:8000 でアクセス")
    print("\nエンドポイント:")
    print("  POST https://localhost:8000/segment")
    print("="*60 + "\n")

    # SSL証明書のパス (webディレクトリのmkcert証明書を使用)
    script_dir = Path(__file__).resolve().parent
    cert_dir = script_dir.parent / "web"
    ssl_keyfile = cert_dir / "localhost+3-key.pem"
    ssl_certfile = cert_dir / "localhost+3.pem"

    print(f"証明書を探しています: {ssl_certfile}")

    # 証明書が存在するか確認
    if ssl_keyfile.exists() and ssl_certfile.exists():
        print(f"✓ SSL証明書を使用: {ssl_certfile}")
        uvicorn.run(
            app,
            host="0.0.0.0",
            port=8000,
            log_level="info",
            ssl_keyfile=str(ssl_keyfile),
            ssl_certfile=str(ssl_certfile),
        )
    else:
        print(f"✗ 警告: SSL証明書が見つかりません")
        print(f"  期待するパス: {ssl_certfile}")
        print(f"  keyfile exists: {ssl_keyfile.exists()}")
        print(f"  certfile exists: {ssl_certfile.exists()}")
        print("\nHTTPで起動します（Quest3からはアクセスできない可能性があります）")
        uvicorn.run(
            app,
            host="0.0.0.0",
            port=8000,
            log_level="info",
        )
