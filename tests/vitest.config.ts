import { defineConfig } from "vitest/config";

// Real models (LLM_API_KEY must be set), so one test at a time with generous timeouts.
export default defineConfig({
  test: {
    testTimeout: 180_000,
    fileParallelism: false,
    env: {
      LLM_BASE_URL: process.env.LLM_BASE_URL ?? "https://ai-gateway.vercel.sh/v1",
      MODEL: process.env.MODEL ?? "deepseek/deepseek-v4.1-flash-1017-fast",
      TASK_MODEL: process.env.TASK_MODEL ?? "deepseek/deepseek-v4.1-flash-1017-fast",
      EMBEDDINGS_URL: "http://127.0.0.1:8092",
      TAILNET_HOST: "biscotti.example.ts.net",
      // Clear of a live biscotti on the same machine.
      PAGES_PORT: "8182",
      VAULT_PORT: "4891",
      VAULT_URL: "http://127.0.0.1:4891",
      DB_KEY: "test-database-key",
    },
  },
});
