import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Test against the core sources so `npm test` does not need a core build first.
    alias: { "@bot-v3/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)) },
  },
});
