import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  // the 3D face is lazy: pre-bundle three, or its first load in dev 504s
  optimizeDeps: { include: ["three", "three/addons/controls/OrbitControls.js", "three/addons/lines/LineMaterial.js", "three/addons/lines/LineSegments2.js", "three/addons/lines/LineSegmentsGeometry.js"] },
  build: { target: "es2022", sourcemap: true },
  server: { host: "127.0.0.1", port: 5317, strictPort: true, allowedHosts: true },
  preview: { host: "127.0.0.1", port: 5318, strictPort: true, allowedHosts: true },
});
