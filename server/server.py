"""
FastSAM WebSocket Server for Quest3 VR
Tailscale経由で接続可能
HTTP POST /segment エンドポイントも提供
"""
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from ultralytics import FastSAM
from simple_lama_inpainting import SimpleLama
import cv2
import base64
import json
import colorsys
import numpy as np
from PIL import Image
from io import BytesIO
import asyncio
from datetime import datetime


class SegmentRequest(BaseModel):
    """Segmentation request schema"""
    image: str  # Base64 encoded
    conf: float = 0.4
    iou: float = 0.9
    max_masks: int = 20
    min_area: float = 0.01  # Minimum area as fraction of image (1% default)
    combined_inpaint: bool = True  # If True, inpaint all masks combined; if False, inpaint each mask individually
    dilate_pixels: int = 10  # Pixels to dilate mask before inpainting


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

# LaMaモデルをロード
print("Loading LaMa model...")
lama_model = SimpleLama()
print("LaMa model loaded successfully!")


def expand_bbox(bbox: list[float], image_size: tuple[int, int], padding_ratio: float = 0.1) -> list[int]:
    """Expand bounding box by padding ratio and return integer coordinates"""
    x1, y1, x2, y2 = bbox
    w, h = x2 - x1, y2 - y1
    pad_x = w * padding_ratio
    pad_y = h * padding_ratio
    return [
        int(max(0, x1 - pad_x)),
        int(max(0, y1 - pad_y)),
        int(min(image_size[0], x2 + pad_x)),
        int(min(image_size[1], y2 + pad_y))
    ]


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

        print(f"[HTTP] Processing image: {image.size}, conf={request.conf}, iou={request.iou}, min_area={request.min_area}")

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
        combined_inpaint_data = None

        if results[0].masks is not None:
            masks = results[0].masks.data.cpu().numpy()
            boxes = results[0].boxes.xyxy.cpu().numpy() if results[0].boxes is not None else None

            # Use mask dimensions for area calculation (FastSAM output size)
            mask_height, mask_width = masks[0].shape if len(masks) > 0 else (1, 1)
            total_area = mask_width * mask_height

            print(f"[HTTP] Mask array shape: {masks.shape}, total_area={total_area}, min_area threshold={request.min_area}")
            print(f"[HTTP] Total masks before filtering: {len(masks)}")
            print(f"[HTTP] Inpaint mode: {'combined' if request.combined_inpaint else 'individual'}, dilate: {request.dilate_pixels}px")

            # First pass: filter masks and collect data
            filtered_masks = []
            mask_id = 0
            skipped_count = 0
            for i, mask in enumerate(masks[:request.max_masks]):
                # Calculate actual mask area by counting non-zero pixels
                binary_mask = (mask > 0.5).astype(np.uint8)
                mask_pixel_count = int(np.sum(binary_mask))
                mask_area_ratio = mask_pixel_count / total_area

                # Filter out small masks
                if mask_area_ratio < request.min_area:
                    print(f"[HTTP] Skipping mask {i}: pixels={mask_pixel_count}, ratio={mask_area_ratio:.4f} < {request.min_area}")
                    skipped_count += 1
                    continue

                print(f"[HTTP] Keeping mask {i}: pixels={mask_pixel_count}, ratio={mask_area_ratio:.4f}")

                # Get bounding box
                bbox = boxes[i].tolist() if boxes is not None and i < len(boxes) else None

                filtered_masks.append({
                    "original_idx": i,
                    "mask_id": mask_id,
                    "binary_mask": binary_mask,
                    "bbox": bbox,
                })
                mask_id += 1

            # Combined inpainting mode: merge all masks and inpaint once
            if request.combined_inpaint and len(filtered_masks) > 0:
                try:
                    # Combine all masks into one
                    combined_mask = np.zeros((mask_height, mask_width), dtype=np.uint8)
                    for fm in filtered_masks:
                        combined_mask = np.maximum(combined_mask, fm["binary_mask"])

                    # Dilate the combined mask
                    if request.dilate_pixels > 0:
                        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (request.dilate_pixels * 2 + 1, request.dilate_pixels * 2 + 1))
                        combined_mask = cv2.dilate(combined_mask, kernel, iterations=1)

                    # Resize to original image size
                    combined_mask_img = Image.fromarray(combined_mask * 255)
                    combined_mask_resized = combined_mask_img.resize(image.size, Image.Resampling.NEAREST)

                    # Run LaMa inpainting once for all masks
                    print(f"[HTTP] Running combined inpainting...")
                    inpaint_start = datetime.now()
                    combined_inpainted = lama_model(image, combined_mask_resized)
                    inpaint_time = (datetime.now() - inpaint_start).total_seconds()
                    print(f"[HTTP] Combined inpainting done in {inpaint_time:.3f}s")

                    # Encode full inpainted image as JPEG
                    inpaint_buffered = BytesIO()
                    combined_inpainted.save(inpaint_buffered, format="JPEG", quality=85)
                    combined_inpaint_data = base64.b64encode(inpaint_buffered.getvalue()).decode()

                except Exception as e:
                    print(f"[HTTP] Combined inpainting failed: {e}")

            # Build mask data
            for fm in filtered_masks:
                binary_mask = fm["binary_mask"]
                bbox = fm["bbox"]
                mask_id = fm["mask_id"]

                # Convert mask to binary image
                binary_mask_img = binary_mask * 255

                # Compress as PNG
                mask_img = Image.fromarray(binary_mask_img)
                buffered = BytesIO()
                mask_img.save(buffered, format="PNG", optimize=True)
                mask_base64 = base64.b64encode(buffered.getvalue()).decode()

                # Individual inpainting (only if not using combined mode)
                inpaint_data = None
                inpaint_bbox = None
                if not request.combined_inpaint and bbox is not None:
                    try:
                        # Dilate mask for better coverage
                        dilated_mask = binary_mask
                        if request.dilate_pixels > 0:
                            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (request.dilate_pixels * 2 + 1, request.dilate_pixels * 2 + 1))
                            dilated_mask = cv2.dilate(binary_mask, kernel, iterations=1)

                        # Resize mask to original image size for inpainting
                        dilated_mask_img = Image.fromarray(dilated_mask * 255)
                        mask_resized = dilated_mask_img.resize(image.size, Image.Resampling.NEAREST)

                        # Run LaMa inpainting
                        inpainted = lama_model(image, mask_resized)

                        # Expand bbox and crop inpainted region
                        inpaint_bbox = expand_bbox(bbox, image.size, padding_ratio=0.15)
                        crop_x1, crop_y1, crop_x2, crop_y2 = inpaint_bbox
                        inpaint_crop = inpainted.crop((crop_x1, crop_y1, crop_x2, crop_y2))

                        # Encode as JPEG
                        inpaint_buffered = BytesIO()
                        inpaint_crop.save(inpaint_buffered, format="JPEG", quality=85)
                        inpaint_data = base64.b64encode(inpaint_buffered.getvalue()).decode()

                        print(f"[HTTP] Inpainted mask {mask_id}: crop size {inpaint_crop.size}")
                    except Exception as e:
                        print(f"[HTTP] Inpainting failed for mask {mask_id}: {e}")

                masks_data.append({
                    "id": mask_id,
                    "data": mask_base64,
                    "width": int(binary_mask.shape[1]),
                    "height": int(binary_mask.shape[0]),
                    "bbox": bbox,
                    "color": generate_distinct_color(mask_id),
                    "inpaint_data": inpaint_data,
                    "inpaint_bbox": inpaint_bbox,
                })

            print(f"[HTTP] Skipped {skipped_count} masks, keeping {len(masks_data)} masks")

        processing_time = (datetime.now() - start_time).total_seconds()

        print(f"[HTTP] Sent {len(masks_data)} masks in {processing_time:.3f}s")

        return {
            "success": True,
            "count": len(masks_data),
            "masks": masks_data,
            "processing_time": processing_time,
            "image_size": list(image.size),
            "combined_inpaint_data": combined_inpaint_data,
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
