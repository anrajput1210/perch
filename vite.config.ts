import { defineConfig } from "vite";

// Tauri expects a fixed port; design.html is the primitives page (dev only).
export default defineConfig({
  clearScreen: false,
  // replica/ holds reference and clone screenshots; writing them must not reload the page
  // src-tauri/ is Rust (its target/ holds locked .exe files that crash the watcher)
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/replica/**", "**/src-tauri/**"] } },
  build: {
    target: "es2022",
    rollupOptions: { input: { main: "index.html", settings: "settings.html", design: "design.html" } },
  },
});
