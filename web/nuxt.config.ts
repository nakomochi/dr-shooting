// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: false },
  devServer: {
    host: "0.0.0.0",
    port: 5173,
    https: {
      key: "./localhost+3-key.pem", // mkcertで生成されるファイル名に合わせる
      cert: "./localhost+3.pem",
    },
  },
  runtimeConfig: {
    public: {
      // セグメンテーションAPIエンドポイント
      // USB-C接続時: adb reverse tcp:8000 tcp:8000
      // 環境変数 NUXT_PUBLIC_SEGMENT_API で上書き可能
      segmentApi: "https://localhost:8000/segment",
    },
  },
  css: ["@/assets/styles/common.scss"],
  vite: {
    css: {
      preprocessorOptions: {
        scss: {
          additionalData: `@use "@/assets/styles/main.scss" as *;`
        },
      },
    },
  },
});
