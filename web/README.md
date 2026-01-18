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
