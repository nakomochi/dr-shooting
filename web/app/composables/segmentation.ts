export type MaskData = {
  id: number;
  /** Base64-encoded PNG mask image */
  data: string;
  width: number;
  height: number;
  /** Bounding box [x1, y1, x2, y2] in image coordinates */
  bbox: [number, number, number, number] | null;
  /** RGB color [r, g, b] (0-255) */
  color: [number, number, number];
  /** Base64-encoded JPEG of inpainted crop region */
  inpaint_data?: string;
  /** Bounding box of inpainted crop [x1, y1, x2, y2] */
  inpaint_bbox?: [number, number, number, number];
};

export type SegmentationResult = {
  success: boolean;
  count: number;
  masks: MaskData[];
  imageSize: [number, number];
  processingTime?: number;
  error?: string;
  /** Combined inpainted image (full image with all masks removed) */
  combinedInpaintData?: string;
};

export type SegmentationOptions = {
  /** Segmentation server endpoint */
  endpoint?: string;
  /** Confidence threshold (default: 0.4) */
  conf?: number;
  /** IoU threshold (default: 0.9) */
  iou?: number;
  /** Maximum number of masks (default: 20) */
  maxMasks?: number;
  /** Minimum area as fraction of image (default: 0.01 = 1%) */
  minArea?: number;
  /** If true, inpaint all masks combined (faster); if false, inpaint each mask individually */
  combinedInpaint?: boolean;
  /** Pixels to dilate mask before inpainting */
  dilatePixels?: number;
  /** Background exclusion method: "none", "segformer", "heuristic" */
  excludeBackground?: "none" | "segformer" | "heuristic";
  /** Overlap ratio threshold for background exclusion (default: 0.5) */
  backgroundOverlapThreshold?: number;
};

const getDefaultEndpoint = (): string => {
  const config = useRuntimeConfig();
  return config.public?.segmentApi as string || "https://localhost:8000/segment";
};

/**
 * Send image to FastSAM server for segmentation
 */
export const requestSegmentation = async (
  imageBase64: string,
  options: SegmentationOptions = {}
): Promise<SegmentationResult> => {
  const {
    endpoint = getDefaultEndpoint(),
    conf = 0.4,
    iou = 0.9,
    maxMasks = 20,
    minArea = 0.005,
    combinedInpaint = true,
    dilatePixels = 10,
    excludeBackground = "segformer",
    backgroundOverlapThreshold = 0.5,
  } = options;

  console.log(`[Segmentation] Sending request to ${endpoint}`);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image: imageBase64,
        conf,
        iou,
        max_masks: maxMasks,
        min_area: minArea,
        combined_inpaint: combinedInpaint,
        dilate_pixels: dilatePixels,
        exclude_background: excludeBackground,
        background_overlap_threshold: backgroundOverlapThreshold,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.success) {
      console.error("[Segmentation] Server returned error:", data.error);
      return {
        success: false,
        count: 0,
        masks: [],
        imageSize: [0, 0],
        error: data.error,
      };
    }

    console.log(
      `[Segmentation] Received ${data.count} masks in ${data.processing_time?.toFixed(3)}s`
    );

    return {
      success: true,
      count: data.count,
      masks: data.masks,
      imageSize: data.image_size,
      processingTime: data.processing_time,
      combinedInpaintData: data.combined_inpaint_data,
    };
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.error("[Segmentation] Request failed:", errorMessage);

    return {
      success: false,
      count: 0,
      masks: [],
      imageSize: [0, 0],
      error: errorMessage,
    };
  }
};
