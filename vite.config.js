import { defineConfig } from "vite";

// base = "/BIM_OASIS/" para GitHub Pages
// en dev usa "/" (raiz local)
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/BIM_OASIS/" : "/",
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 8000,
  },
}));
