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
};

export type SegmentationResult = {
  success: boolean;
  count: number;
  masks: MaskData[];
  imageSize: [number, number];
  processingTime?: number;
  error?: string;
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
