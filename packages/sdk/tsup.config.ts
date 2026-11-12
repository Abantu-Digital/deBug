import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    react: "src/react.tsx",
    "react-native": "src/react-native.ts",
    expo: "src/expo.ts",
    "expo-router": "src/expo-router.ts",
    node: "src/node.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2019", // Hermes and older Safari: no newer syntax in the shipped code
  splitting: true,
  treeshake: true,
  // Everything the app already has stays external; the schema core is inlined so the SDK has no runtime deps on zod.
  external: ["react", "react-native", "expo-device", "expo-application", "expo-router", "node:os"],
  noExternal: ["@debug/schema"],
});
