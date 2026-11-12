import { defineConfig } from "tsup";

export default defineConfig({
  entry: {"index":"src/index.ts","memory":"src/memory.ts","firestore":"src/firestore.ts","dynamodb":"src/dynamodb.ts"},
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node18",
  splitting: true,
  external: ["firebase-admin","@aws-sdk/client-dynamodb","@aws-sdk/lib-dynamodb"],
});
