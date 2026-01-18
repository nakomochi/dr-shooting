// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: true },
  devServer: {
    host: "0.0.0.0",
    port: 3001,
    https: {
      key: "./localhost+3-key.pem", // mkcertで生成されるファイル名に合わせる
      cert: "./localhost+3.pem",
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
