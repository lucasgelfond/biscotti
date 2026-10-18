import { defineConfig } from "vitest/config";

// Each test talks to a real model, so they run one at a time with generous timeouts. The models are production's,
// through the AI Gateway (AI_GATEWAY_API_KEY must be set).
export default defineConfig({
  test: {
    testTimeout: 180_000,
    fileParallelism: false,
    env: {
      MODEL: process.env.MODEL ?? "deepseek/deepseek-v4.1-flash-1017-fast",
      TASK_MODEL: process.env.TASK_MODEL ?? "deepseek/deepseek-v4.1-flash-1017-fast",
      EMBEDDINGS_URL: "http://127.0.0.1:8092",
      EXECUTOR_URL: "http://127.0.0.1:8095",
      EXECUTOR_ORIGIN: "http://127.0.0.1:8095",
      TAILNET_HOST: "biscotti.example.ts.net",
      // Clear of a live biscotti on the same machine.
      PAGES_PORT: "8182",
      SECRETS_PORT: "4891",
      SECRETS_URL: "http://127.0.0.1:4891",
    },
  },
});
