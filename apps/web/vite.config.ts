import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  envDir: "../../",
  base: process.env.VITE_BASE_PATH || "/",
  server: { host: "0.0.0.0" },
});
