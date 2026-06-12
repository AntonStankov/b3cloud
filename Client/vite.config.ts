import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The b3cloud user API runs on :9001 in local dev. Proxy API paths so the
// browser can use same-origin requests like the deployed setup.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/apps": "http://127.0.0.1:9001",
      "/deploy-jobs": "http://127.0.0.1:9001",
      "/health": "http://127.0.0.1:9001",
    },
  },
});
