using UnityEngine;
using System;
using System.Collections;
using System.Collections.Generic;
using NativeWebSocket;
using System.Text;

/// <summary>
/// FastSAM WebSocketクライアント（Quest3用）
/// Tailscale経由でPCサーバーに接続
/// </summary>
public class FastSAMClient : MonoBehaviour
{
    [Header("Server Settings")]
    [Tooltip("TailscaleのPC IPアドレス (例: 100.x.x.x)")]
    public string serverIP = "100.100.100.100";
    public int serverPort = 8000;
    
    [Header("FastSAM Parameters")]
    [Range(0.1f, 0.9f)]
    public float confidenceThreshold = 0.4f;
    [Range(0.1f, 0.9f)]
    public float iouThreshold = 0.9f;
    public int maxMasks = 10;
    
    [Header("Status")]
    public bool isConnected = false;
    public int lastMaskCount = 0;
    public float lastProcessingTime = 0f;
    
    private WebSocket websocket;
    private Queue<Action> mainThreadActions = new Queue<Action>();
    
    // イベント
    public event Action OnConnected;
    public event Action OnDisconnected;
    public event Action<FastSAMResponse> OnSegmentationReceived;
    
    async void Start()
    {
        // WebSocket接続を確立
        string wsUrl = $"ws://{serverIP}:{serverPort}/ws";
        Debug.Log($"Connecting to FastSAM server: {wsUrl}");
        
        websocket = new WebSocket(wsUrl);
        
        websocket.OnOpen += () =>
        {
            Debug.Log("WebSocket connected!");
            isConnected = true;
            EnqueueMainThreadAction(() => OnConnected?.Invoke());
        };
        
        websocket.OnError += (e) =>
        {
            Debug.LogError($"WebSocket error: {e}");
        };
        
        websocket.OnClose += (e) =>
        {
            Debug.Log($"WebSocket closed: {e}");
            isConnected = false;
            EnqueueMainThreadAction(() => OnDisconnected?.Invoke());
        };
        
        websocket.OnMessage += (bytes) =>
        {
            string message = Encoding.UTF8.GetString(bytes);
            HandleServerMessage(message);
        };
        
        await websocket.Connect();
    }
    
    void Update()
    {
        #if !UNITY_WEBGL || UNITY_EDITOR
        websocket?.DispatchMessageQueue();
        #endif
        
        // メインスレッドでのアクション実行
        while (mainThreadActions.Count > 0)
        {
            mainThreadActions.Dequeue()?.Invoke();
        }
    }
    
    /// <summary>
    /// 画像を送信してセグメンテーションを実行
    /// </summary>
    public async void SendImage(Texture2D texture)
    {
        if (!isConnected)
        {
            Debug.LogWarning("WebSocket not connected");
            return;
        }
        
        // Texture2DをJPEGにエンコード
        byte[] imageBytes = texture.EncodeToJPG(75);
        string base64Image = Convert.ToBase64String(imageBytes);
        
        // リクエストを作成
        var request = new FastSAMRequest
        {
            image = base64Image,
            conf = confidenceThreshold,
            iou = iouThreshold,
            max_masks = maxMasks
        };
        
        string json = JsonUtility.ToJson(request);
        
        Debug.Log($"Sending image ({imageBytes.Length / 1024}KB) to server...");
        await websocket.SendText(json);
    }
    
    /// <summary>
    /// カメラから画像をキャプチャして送信
    /// </summary>
    public void CaptureAndSend(Camera camera)
    {
        StartCoroutine(CaptureCamera(camera));
    }
    
    private IEnumerator CaptureCamera(Camera camera)
    {
        // レンダーテクスチャにキャプチャ
        int width = 640;
        int height = 480;
        RenderTexture rt = new RenderTexture(width, height, 24);
        camera.targetTexture = rt;
        camera.Render();
        
        RenderTexture.active = rt;
        Texture2D screenshot = new Texture2D(width, height, TextureFormat.RGB24, false);
        screenshot.ReadPixels(new Rect(0, 0, width, height), 0, 0);
        screenshot.Apply();
        
        camera.targetTexture = null;
        RenderTexture.active = null;
        Destroy(rt);
        
        // 送信
        SendImage(screenshot);
        
        yield return null;
    }
    
    private void HandleServerMessage(string message)
    {
        try
        {
            var response = JsonUtility.FromJson<FastSAMResponse>(message);
            
            if (response.success)
            {
                lastMaskCount = response.count;
                lastProcessingTime = response.processing_time;
                
                Debug.Log($"Received {response.count} segments in {response.processing_time:F3}s");
                
                EnqueueMainThreadAction(() => OnSegmentationReceived?.Invoke(response));
            }
            else
            {
                Debug.LogError($"Server error: {response.error}");
            }
        }
        catch (Exception e)
        {
            Debug.LogError($"Failed to parse server response: {e.Message}");
        }
    }
    
    private void EnqueueMainThreadAction(Action action)
    {
        lock (mainThreadActions)
        {
            mainThreadActions.Enqueue(action);
        }
    }
    
    async void OnDestroy()
    {
        if (websocket != null)
        {
            await websocket.Close();
        }
    }
    
    async void OnApplicationQuit()
    {
        if (websocket != null)
        {
            await websocket.Close();
        }
    }
}

[Serializable]
public class FastSAMRequest
{
    public string image;
    public float conf;
    public float iou;
    public int max_masks;
}

[Serializable]
public class FastSAMResponse
{
    public bool success;
    public int count;
    public MaskData[] masks;
    public float processing_time;
    public int[] image_size;
    public string error;
    public string message;
}

[Serializable]
public class MaskData
{
    public int id;
    public string data;  // Base64 encoded PNG
    public int width;
    public int height;
}
