import type { WebGLRenderer } from "three";

export type CameraCaptureHandle = {
  /** Capture camera as Base64 JPEG */
  capture: (frame?: XRFrame) => Promise<string | null>;
  /** Whether getUserMedia camera is available */
  isCameraAvailable: () => boolean;
  /** Initialize camera (call at XR session start) */
  initCamera: () => Promise<boolean>;
  /** Get camera FOV in degrees, null if unknown */
  getCameraFov: () => number | null;
  /** Release resources */
  dispose: () => void;
};

export type CameraCaptureOptions = {
  renderer: WebGLRenderer;
};

/**
 * Create camera capture handler
 * Uses getUserMedia API to access passthrough camera on Quest Browser
 */
export const createCameraCapture = (
  options: CameraCaptureOptions
): CameraCaptureHandle => {
  const { renderer } = options;

  let cameraAvailable = false;
  let videoElement: HTMLVideoElement | null = null;
  let mediaStream: MediaStream | null = null;
  let captureCanvas: HTMLCanvasElement | null = null;
  let captureCtx: CanvasRenderingContext2D | null = null;
  let detectedFov: number | null = null;

  const QUEST3_DEFAULT_FOV = 97;

  const initCamera = async (): Promise<boolean> => {
    try {
      console.log("[CameraCapture] Initializing camera via getUserMedia...");

      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter((d) => d.kind === "videoinput");
      console.log("[CameraCapture] Available video devices:", videoDevices.length);

      for (const device of videoDevices) {
        console.log(`[CameraCapture] - ${device.label || device.deviceId}`);
      }

      let deviceId: string | undefined;
      const externalCamera = videoDevices.find(
        (d) =>
          d.label.toLowerCase().includes("external") ||
          d.label.toLowerCase().includes("passthrough") ||
          d.label.toLowerCase().includes("environment")
      );
      if (externalCamera) {
        deviceId = externalCamera.deviceId;
        console.log("[CameraCapture] Using external camera:", externalCamera.label);
      } else if (videoDevices.length > 0) {
        deviceId = videoDevices[videoDevices.length - 1]?.deviceId;
        console.log("[CameraCapture] Using last available camera");
      }

      const constraints: MediaStreamConstraints = {
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 960 },
          facingMode: deviceId ? undefined : { ideal: "environment" },
        },
        audio: false,
      };

      mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      console.log("[CameraCapture] Got media stream");

      videoElement = document.createElement("video");
      videoElement.srcObject = mediaStream;
      videoElement.setAttribute("playsinline", "true");
      videoElement.muted = true;

      await new Promise<void>((resolve, reject) => {
        if (!videoElement) {
          reject(new Error("Video element not created"));
          return;
        }
        videoElement.onloadedmetadata = () => {
          videoElement!.play().then(resolve).catch(reject);
        };
        videoElement.onerror = () => reject(new Error("Video load error"));
      });

      const width = videoElement.videoWidth;
      const height = videoElement.videoHeight;
      console.log(`[CameraCapture] Video ready: ${width}x${height}`);

      const videoTrack = mediaStream.getVideoTracks()[0];
      if (videoTrack) {
        const settings = videoTrack.getSettings();
        console.log("[CameraCapture] Video track settings:", settings);
        if ((settings as any).fieldOfView) {
          detectedFov = (settings as any).fieldOfView;
          console.log(`[CameraCapture] Detected FOV: ${detectedFov}`);
        }
      }

      captureCanvas = document.createElement("canvas");
      captureCanvas.width = width;
      captureCanvas.height = height;
      captureCtx = captureCanvas.getContext("2d");

      cameraAvailable = true;
      console.log("[CameraCapture] Camera initialized successfully");
      return true;
    } catch (e) {
      console.error("[CameraCapture] Failed to initialize camera:", e);
      cameraAvailable = false;
      return false;
    }
  };

  const captureFromCanvas = async (): Promise<string | null> => {
    try {
      const canvas = renderer.domElement;
      const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
      const base64 = dataUrl.split(",")[1];

      if (!base64) {
        console.error("[CameraCapture] Failed to get base64 from canvas");
        return null;
      }

      console.log(
        `[CameraCapture] Captured from WebGL canvas: ${canvas.width}x${canvas.height}`
      );
      return base64;
    } catch (e) {
      console.error("[CameraCapture] Canvas capture failed:", e);
      return null;
    }
  };

  const captureFromCamera = async (): Promise<string | null> => {
    if (!videoElement || !captureCanvas || !captureCtx) {
      console.warn("[CameraCapture] Video or canvas not ready");
      return null;
    }

    try {
      captureCtx.drawImage(
        videoElement,
        0,
        0,
        captureCanvas.width,
        captureCanvas.height
      );

      const dataUrl = captureCanvas.toDataURL("image/jpeg", 0.8);
      const base64 = dataUrl.split(",")[1];

      if (!base64) {
        console.error("[CameraCapture] Failed to get base64 from camera");
        return null;
      }

      console.log(
        `[CameraCapture] Captured from getUserMedia: ${captureCanvas.width}x${captureCanvas.height}`
      );
      return base64;
    } catch (e) {
      console.error("[CameraCapture] Camera capture failed:", e);
      return null;
    }
  };

  const capture = async (_frame?: XRFrame): Promise<string | null> => {
    console.log(
      `[CameraCapture] capture() called: cameraAvailable=${cameraAvailable}`
    );

    if (cameraAvailable) {
      const result = await captureFromCamera();
      if (result) return result;
    }

    return captureFromCanvas();
  };

  const isCameraAvailable = () => cameraAvailable;

  const getCameraFov = (): number | null => {
    if (detectedFov) return detectedFov;
    if (cameraAvailable) return QUEST3_DEFAULT_FOV;
    return null;
  };

  const dispose = () => {
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
    }
    if (videoElement) {
      videoElement.srcObject = null;
      videoElement = null;
    }
    captureCanvas = null;
    captureCtx = null;
    cameraAvailable = false;
    console.log("[CameraCapture] Disposed");
  };

  return {
    capture,
    isCameraAvailable,
    initCamera,
    getCameraFov,
    dispose,
  };
};
