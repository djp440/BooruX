import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 48301,
    proxy: {
      "/api": "http://127.0.0.1:48300",
    },
  },
  // Go embed 只能引用同包目录，因此产物直接写入 server-go/web。
  build: {
    outDir: "../server-go/web",
    emptyOutDir: true,
  },
});
