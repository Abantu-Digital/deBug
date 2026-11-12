import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
  ssr: {
    // Server-only SDKs: keep them out of the bundle and load from node_modules at runtime.
    external: ["firebase-admin", "@aws-sdk/client-dynamodb", "@aws-sdk/lib-dynamodb"],
  },
});
