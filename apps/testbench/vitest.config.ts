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
          // The jsdom projects run in parallel and contend for the machine:
          // tests that take under two seconds alone have exceeded the 5s
          // default under full-suite load. The budget is generous on purpose,
          // so a slow machine does not produce failures that are really
          // scheduling.
          testTimeout: 20_000,
        },
      },
    ],
  },
});
