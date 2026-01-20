# FastSAM Segmentation Server

Quest3向けセグメンテーション＋背景補完サーバー（USB-C接続）

## 起動

```bash
cd server
uv sync
uv run python server.py
```

Quest3接続：
```bash
adb reverse tcp:8000 tcp:8000
```

## API

**POST /segment**

```json
{
    "image": "base64_encoded_jpeg",
    "conf": 0.4,
    "iou": 0.9,
    "exclude_background": "segformer"
}
```

## 使用モデル

- FastSAM-s（セグメンテーション）
- LaMa（背景補完）
- SegFormer-B0（背景検出）
