import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // `lib/vindex/*` modules import "server-only", which throws outside the
      // Next.js react-server condition. Replace it with an empty module so the
      // modules can be imported in plain Node unit tests.
      "server-only": fileURLToPath(
        new URL("./tests/unit/helpers/server-only-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    // The DB-backed suites share one Postgres test database and one position
    // id; parallel file workers race each other's seeds/arms, so run files
    // sequentially (tests within a file stay independent).
    fileParallelism: false,
  },
});
