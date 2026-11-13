import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

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
  external: ["react", "react-native", "react-native-device-info", "expo-device", "expo-application", "expo-router", "node:os"],
  // esbuild turns require() in ESM output into a __require() shim. Metro (which reads the ESM
  // build) only bundles literal require("…") calls, so put the device-info one back.
  async onSuccess() {
    for (const f of readdirSync("dist")) {
      if (!f.endsWith(".js")) continue;
      const file = `dist/${f}`;
      const src = readFileSync(file, "utf8");
      const out = src.replace(/__require\("react-native-device-info"\)/g, 'require("react-native-device-info")');
      if (out !== src) writeFileSync(file, out);
    }
  },
  noExternal: ["@debugkit/schema"],
  define: { __DEBUGKIT_SDK_VERSION__: JSON.stringify(version) },
});
