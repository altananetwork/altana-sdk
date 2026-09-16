import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Two projects: pure helpers run under node, panels need a DOM.
export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "lib", include: ["tests/lib/**/*.test.ts", "tests/brand.test.ts"], environment: "node" },
      },
      {
        plugins: [react()],
        test: {
          name: "components",
          include: ["tests/components/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["./src/test/setup.ts"],
        },
      },
    ],
  },
});
