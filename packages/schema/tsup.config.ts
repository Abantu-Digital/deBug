import { defineConfig } from "tsup";

export default defineConfig({
  entry: {"index":"src/index.ts","core":"src/core.ts"},
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node18",
  splitting: true,
  external: [],
});
