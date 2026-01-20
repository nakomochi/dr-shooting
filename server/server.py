"""
FastSAM WebSocket Server for Quest3 VR
Tailscale経由で接続可能
HTTP POST /segment エンドポイントも提供
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from ultralytics import FastSAM
from simple_lama_inpainting import SimpleLama
from typing import Literal
from transformers import SegformerForSemanticSegmentation, SegformerImageProcessor
import torch
import cv2
import base64
import colorsys
import numpy as np
from PIL import Image
from io import BytesIO
import asyncio
from datetime import datetime
from pathlib import Path

# 出力ディレクトリを作成
OUTPUT_DIR = Path(__file__).resolve().parent / "output"
OUTPUT_DIR.mkdir(exist_ok=True)


class SegmentRequest(BaseModel):
    """Segmentation request schema"""
    image: str  # Base64 encoded
    conf: float = 0.25
    iou: float = 0.9
    max_masks: int = 20
    min_area: float = 0.005  # Minimum area as fraction of image (0.5% default)
    combined_inpaint: bool = True  # If True, inpaint all masks combined; if False, inpaint each mask individually
    dilate_pixels: int = 10  # Pixels to dilate mask before inpainting
    inpaint_scale: float = 0.25  # Scale factor for inpainting (0.25-1.0, lower = faster but lower quality)
    exclude_background: Literal["none", "segformer", "heuristic"] = "none"  # Background exclusion method
    background_overlap_threshold: float = 0.5  # Overlap ratio threshold for background exclusion


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

# SegFormerモデルをロード (ADE20K学習済み、壁/床/天井検出用)
print("Loading SegFormer model...")
segformer_processor = SegformerImageProcessor.from_pretrained("nvidia/segformer-b0-finetuned-ade-512-512")
segformer_model = SegformerForSemanticSegmentation.from_pretrained("nvidia/segformer-b0-finetuned-ade-512-512")
print("SegFormer model loaded successfully!")

# ADE20Kの背景クラスID (壁=0, 床=3, 天井=5)
BACKGROUND_CLASS_IDS = [0, 3, 5]


def create_mask_overlay(img_array: np.ndarray, masks: np.ndarray) -> np.ndarray:
    """マスクを画像にオーバーレイして可視化"""
    overlay = img_array.copy()
    for i, mask in enumerate(masks):
        # マスクを元画像サイズにリサイズ
        mask_resized = cv2.resize(
            (mask > 0.5).astype(np.uint8),
            (img_array.shape[1], img_array.shape[0]),
            interpolation=cv2.INTER_NEAREST
        )
        color = generate_distinct_color(i)
        # マスク領域に色を重ねる
        for c in range(3):
            overlay[:, :, c] = np.where(
                mask_resized > 0,
                overlay[:, :, c] * 0.5 + color[c] * 0.5,
                overlay[:, :, c]
            )
    return overlay


async def save_debug_images(
    timestamp: str,
    original_image: Image.Image,
    raw_masks: np.ndarray | None,
    filtered_masks: np.ndarray | None,
    inpainted_image: Image.Image | None,
    background_mask: np.ndarray | None = None,
    segformer_predicted: np.ndarray | None = None,
):
    """非同期で画像をoutputディレクトリに保存"""
    try:
        # 元画像をnumpy配列に変換
        img_array = np.array(original_image.convert("RGB"))

        # 元画像を保存
        original_path = OUTPUT_DIR / f"{timestamp}_original.jpg"
        original_image.save(original_path, format="JPEG", quality=90)
        print(f"[DEBUG] Saved: {original_path}")

        # フィルタリング前のセグメンテーション結果を保存
        if raw_masks is not None and len(raw_masks) > 0:
            overlay_all = create_mask_overlay(img_array, raw_masks)
            segmented_all_path = OUTPUT_DIR / f"{timestamp}_segmented_all.jpg"
            Image.fromarray(overlay_all.astype(np.uint8)).save(segmented_all_path, format="JPEG", quality=90)
            print(f"[DEBUG] Saved: {segmented_all_path} ({len(raw_masks)} masks)")

        # フィルタリング後のセグメンテーション結果を保存
        if filtered_masks is not None and len(filtered_masks) > 0:
            overlay_filtered = create_mask_overlay(img_array, filtered_masks)
            segmented_path = OUTPUT_DIR / f"{timestamp}_segmented.jpg"
            Image.fromarray(overlay_filtered.astype(np.uint8)).save(segmented_path, format="JPEG", quality=90)
            print(f"[DEBUG] Saved: {segmented_path} ({len(filtered_masks)} masks)")

        # Inpaint結果を保存
        if inpainted_image is not None:
            inpainted_path = OUTPUT_DIR / f"{timestamp}_inpainted.jpg"
            inpainted_image.save(inpainted_path, format="JPEG", quality=90)
            print(f"[DEBUG] Saved: {inpainted_path}")

        # 背景マスク（SegFormer）を保存
        if background_mask is not None:
            # 背景マスクを元画像サイズにリサイズ
            bg_resized = cv2.resize(
                background_mask,
                (img_array.shape[1], img_array.shape[0]),
                interpolation=cv2.INTER_NEAREST
            )
            # 背景領域を赤でオーバーレイ
            bg_overlay = img_array.copy()
            bg_overlay[:, :, 0] = np.where(bg_resized > 0, 255, bg_overlay[:, :, 0])  # R
            bg_overlay[:, :, 1] = np.where(bg_resized > 0, bg_overlay[:, :, 1] * 0.5, bg_overlay[:, :, 1])  # G
            bg_overlay[:, :, 2] = np.where(bg_resized > 0, bg_overlay[:, :, 2] * 0.5, bg_overlay[:, :, 2])  # B
            background_path = OUTPUT_DIR / f"{timestamp}_background.jpg"
            Image.fromarray(bg_overlay.astype(np.uint8)).save(background_path, format="JPEG", quality=90)
            print(f"[DEBUG] Saved: {background_path}")

        # SegFormer全クラス予測結果を保存
        if segformer_predicted is not None:
            # 各クラスに固有の色を割り当てて可視化
            pred_resized = cv2.resize(
                segformer_predicted.astype(np.uint8),
                (img_array.shape[1], img_array.shape[0]),
                interpolation=cv2.INTER_NEAREST
            )
            # クラスごとに色を生成
            segformer_overlay = img_array.copy()
            unique_classes = np.unique(pred_resized)
            for class_id in unique_classes:
                color = generate_distinct_color(class_id)
                mask = pred_resized == class_id
                for c in range(3):
                    segformer_overlay[:, :, c] = np.where(
                        mask,
                        segformer_overlay[:, :, c] * 0.4 + color[c] * 0.6,
                        segformer_overlay[:, :, c]
                    )
            segformer_path = OUTPUT_DIR / f"{timestamp}_segformer.jpg"
            Image.fromarray(segformer_overlay.astype(np.uint8)).save(segformer_path, format="JPEG", quality=90)
            print(f"[DEBUG] Saved: {segformer_path} ({len(unique_classes)} classes)")

    except Exception as e:
        print(f"[DEBUG] Failed to save debug images: {e}")


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


def get_background_mask_segformer(image: Image.Image) -> np.ndarray:
    """SegFormerで壁/床/天井のマスクを取得"""
    inputs = segformer_processor(images=image, return_tensors="pt")
    with torch.no_grad():
        outputs = segformer_model(**inputs)
    logits = outputs.logits  # (1, num_classes, H, W)

    # 最も確率の高いクラスを取得
    predicted = logits.argmax(dim=1).squeeze().cpu().numpy()

    # 背景クラス（壁/床/天井）に該当するピクセルをマスク
    background_mask = np.isin(predicted, BACKGROUND_CLASS_IDS)

    return background_mask.astype(np.uint8), predicted


def filter_masks_by_background(
    fastsam_masks: np.ndarray,
    background_mask: np.ndarray,
    threshold: float = 0.5
) -> tuple[list[int], list[float]]:
    """
    壁/床/天井と重複するマスクを除外

    Returns:
        filtered_indices: 保持するマスクのインデックス
        overlap_ratios: 各マスクの背景との重複率
    """
    # background_maskをFastSAMマスクサイズにリサイズ
    mask_h, mask_w = fastsam_masks[0].shape
    bg_resized = cv2.resize(
        background_mask,
        (mask_w, mask_h),
        interpolation=cv2.INTER_NEAREST
    )

    filtered_indices = []
    overlap_ratios = []

    for i, mask in enumerate(fastsam_masks):
        binary_mask = (mask > 0.5).astype(np.uint8)
        mask_area = np.sum(binary_mask)
        if mask_area == 0:
            overlap_ratios.append(0.0)
            continue

        # 背景との重複率を計算
        overlap = np.sum(binary_mask & bg_resized)
        overlap_ratio = overlap / mask_area
        overlap_ratios.append(overlap_ratio)

        if overlap_ratio < threshold:
            filtered_indices.append(i)
        else:
            print(f"[HTTP] Excluded mask {i}: {overlap_ratio:.1%} overlap with wall/floor/ceiling")

    return filtered_indices, overlap_ratios


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

        print(f"[HTTP] Processing image: {image.size}, conf={request.conf}, iou={request.iou}, min_area={request.min_area}, exclude_background={request.exclude_background}")

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
        combined_inpainted = None  # PIL Image for debug saving
        raw_masks = None  # numpy array for debug visualization
        background_mask = None  # SegFormerの背景マスク（デバッグ用）
        segformer_predicted = None  # SegFormerの全クラス予測（デバッグ用）

        if results[0].masks is not None:
            masks = results[0].masks.data.cpu().numpy()
            raw_masks = masks  # Store for debug visualization
            boxes = results[0].boxes.xyxy.cpu().numpy() if results[0].boxes is not None else None

            # Use mask dimensions for area calculation (FastSAM output size)
            mask_height, mask_width = masks[0].shape if len(masks) > 0 else (1, 1)
            total_area = mask_width * mask_height

            print(f"[HTTP] Mask array shape: {masks.shape}, total_area={total_area}, min_area threshold={request.min_area}")
            print(f"[HTTP] Total masks before filtering: {len(masks)}")
            print(f"[HTTP] Inpaint mode: {'combined' if request.combined_inpaint else 'individual'}, dilate: {request.dilate_pixels}px")

            # 背景除外フィルタリング
            background_excluded_indices = None
            if request.exclude_background == "segformer":
                print("[HTTP] Running SegFormer for background detection...")
                segformer_start = datetime.now()
                background_mask, segformer_predicted = get_background_mask_segformer(image)
                segformer_time = (datetime.now() - segformer_start).total_seconds()
                print(f"[HTTP] SegFormer done in {segformer_time:.3f}s")

                background_excluded_indices, overlap_ratios = filter_masks_by_background(
                    masks[:request.max_masks],
                    background_mask,
                    request.background_overlap_threshold
                )
                print(f"[HTTP] Background filter: {len(masks[:request.max_masks])} -> {len(background_excluded_indices)} masks")
            elif request.exclude_background == "heuristic":
                # 将来の拡張用
                print("[HTTP] Heuristic background filter not implemented yet")
                background_excluded_indices = list(range(min(len(masks), request.max_masks)))
            else:
                # フィルタリングなし
                background_excluded_indices = list(range(min(len(masks), request.max_masks)))

            # First pass: filter masks and collect data
            filtered_masks = []
            mask_id = 0
            skipped_count = 0
            for i, mask in enumerate(masks[:request.max_masks]):
                # 背景フィルタで除外されたマスクはスキップ
                if i not in background_excluded_indices:
                    skipped_count += 1
                    continue
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

                    # Scale down for faster inpainting
                    inpaint_scale = max(0.25, min(1.0, request.inpaint_scale))
                    original_size = image.size
                    if inpaint_scale < 1.0:
                        scaled_size = (int(original_size[0] * inpaint_scale), int(original_size[1] * inpaint_scale))
                        image_scaled = image.resize(scaled_size, Image.Resampling.LANCZOS)
                        mask_scaled = combined_mask_resized.resize(scaled_size, Image.Resampling.NEAREST)
                        print(f"[HTTP] Inpainting at {inpaint_scale:.0%} scale: {scaled_size[0]}x{scaled_size[1]}")
                    else:
                        image_scaled = image
                        mask_scaled = combined_mask_resized

                    # Run LaMa inpainting once for all masks
                    print(f"[HTTP] Running combined inpainting...")
                    inpaint_start = datetime.now()
                    inpainted_scaled = lama_model(image_scaled, mask_scaled)
                    inpaint_time = (datetime.now() - inpaint_start).total_seconds()
                    print(f"[HTTP] Combined inpainting done in {inpaint_time:.3f}s")

                    # Scale back up to original size if needed
                    if inpaint_scale < 1.0:
                        combined_inpainted = inpainted_scaled.resize(original_size, Image.Resampling.LANCZOS)
                    else:
                        combined_inpainted = inpainted_scaled

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

                # Convert mask to binary image and resize to original image size
                binary_mask_img = binary_mask * 255
                mask_img_full = Image.fromarray(binary_mask_img)
                mask_img_resized = mask_img_full.resize(image.size, Image.Resampling.NEAREST)

                # Crop mask to bbox region
                if bbox is not None:
                    x1, y1, x2, y2 = [int(v) for v in bbox]
                    # Clamp to image bounds
                    x1 = max(0, x1)
                    y1 = max(0, y1)
                    x2 = min(image.size[0], x2)
                    y2 = min(image.size[1], y2)
                    mask_cropped = mask_img_resized.crop((x1, y1, x2, y2))
                    crop_width = x2 - x1
                    crop_height = y2 - y1
                else:
                    mask_cropped = mask_img_resized
                    crop_width = image.size[0]
                    crop_height = image.size[1]

                # Compress as PNG
                buffered = BytesIO()
                mask_cropped.save(buffered, format="PNG", optimize=True)
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
                    "width": crop_width,
                    "height": crop_height,
                    "bbox": bbox,
                    "color": generate_distinct_color(mask_id),
                    "inpaint_data": inpaint_data,
                    "inpaint_bbox": inpaint_bbox,
                })

            print(f"[HTTP] Skipped {skipped_count} masks, keeping {len(masks_data)} masks")

            # フィルタリング後のマスクを配列に変換
            filtered_masks_array = np.array([fm["binary_mask"] for fm in filtered_masks]) if filtered_masks else None
        else:
            filtered_masks_array = None

        processing_time = (datetime.now() - start_time).total_seconds()

        print(f"[HTTP] Sent {len(masks_data)} masks in {processing_time:.3f}s")

        # 非同期でデバッグ画像を保存（レスポンス返却後）
        timestamp = start_time.strftime("%Y%m%d_%H%M%S")
        asyncio.create_task(save_debug_images(
            timestamp=timestamp,
            original_image=image,
            raw_masks=raw_masks,
            filtered_masks=filtered_masks_array,
            inpainted_image=combined_inpainted,
            background_mask=background_mask,
            segformer_predicted=segformer_predicted,
        ))

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
