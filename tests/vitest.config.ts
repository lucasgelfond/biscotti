import { defineConfig } from "vitest/config";

// Each test talks to a real model, so they run one at a time with generous timeouts.
export default defineConfig({ test: { testTimeout: 180_000, fileParallelism: false } });
