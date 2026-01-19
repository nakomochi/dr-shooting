# Web

## Setup

```bash
bun install --frozen-lockfile
```

## Development

```bash
bun run dev
```

## Quest 3で開発環境を確認する（WebXR）

WebXRはHTTPSが必須

### 1. mkcertで証明書を作成

```bash
sudo apt install mkcert
mkcert -install
```

/webで証明書を生成（IPは`ipconfig`(PowerShell)で確認して置き換える）:

```bash
cd web
mkcert localhost 127.0.0.1 ::1 192.168.x.x
```

生成されたファイル名を`nuxt.config.ts`の`https`設定と一致させる。

### 2. Quest 3からアクセス

**WiFi経由:**
1. PCとQuest 3を同じWiFiに接続
2. `bun run dev`
3. Quest 3ブラウザで `https://192.168.x.x:3001`

**USB-C経由:**
1. Quest 3の開発者モードを有効化
2. USB接続してデバッグを許可
3. 接続したPC(PowerShellなど)で `adb reverse tcp:3001 tcp:3001`
4. Quest 3ブラウザで `https://localhost:3001`


## キャリブレーションモード

カメラ画像座標と3D空間のずれを補正するためのキャリブレーション機能。

### キャリブレーションの実行方法

1. `Screen.vue` で `IS_CALIBRATION_MODE = true` に設定
2. アプリを起動してセグメンテーションを実行
3. マスクが表示されたら、コントローラーで位置を調整:
   - **左スティック**: マスクを上下左右に移動
   - **右スティック（上下）**: マスクを奥/手前に移動（深度調整）
   - **トリガー（squeeze）**: 現在位置を確定、次のマスクへ
4. 5枚のマスクを調整後、パラメータが自動計算され、ログに表示される
5. `IS_CALIBRATION_MODE = false` に戻して通常モードで使用

### パラメータの手動設定

キャリブレーション結果は手動で `Screen.vue` のフォールバック値を編集:

```typescript
const calibrationParams = IS_CALIBRATION_MODE
  ? { scaleFactor: 1.0, offsetX: 0, offsetY: 0 }
  : savedCalibrationParams
    ? { ... }
    : { scaleFactor: 0.32, offsetX: -0.23, offsetY: 0.22 }; // ここを調整
```
