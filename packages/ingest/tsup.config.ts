import { defineConfig } from "tsup";

export default defineConfig({
  entry: {"index":"src/index.ts","firebase":"src/firebase.ts","lambda":"src/lambda.ts"},
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node18",
  splitting: true,
  external: [],
});
