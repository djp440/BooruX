import { defineConfig } from "@playwright/test";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const db = join(root, ".e2e-data", "bookmarks.db");

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:48300", headless: true },
  webServer: {
    command: `go run .`,
    cwd: join(root, "server-go"),
    url: "http://127.0.0.1:48300/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: { ...process.env, PORT: "48300", DB_PATH: db },
  },
});
