import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    // WebAuthn requires either localhost or HTTPS. localhost is fine for dev.
    host: "localhost",
  },
  // Porto + ox use modern ESM; nothing to polyfill for the browser path.
});
