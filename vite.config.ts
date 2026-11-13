import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/client",
  plugins: [react()],
  build: {
    outDir: "../../dist/assets",
    emptyOutDir: true,
    modulePreload: false,
    cssCodeSplit: false,
    assetsDir: "static",
  },
});
