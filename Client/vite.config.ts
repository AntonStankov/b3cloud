import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiProxyTarget =
    env.VITE_API_PROXY_TARGET ||
    "http://api.zerotrust-docker-home-server-test.download";

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api/v1": apiProxyTarget,
        "/apps": apiProxyTarget,
        "/deploy-jobs": apiProxyTarget,
        "/health": apiProxyTarget,
      },
    },
  };
});
