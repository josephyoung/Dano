import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";
import danoConfig from "./dano.config.json";

const typesRoot = fileURLToPath(new URL("./apps/dano/types/", import.meta.url));

export default defineConfig({
  define: {
    __DANO_DEFAULT_PRODUCT_NAME__: JSON.stringify(danoConfig.productName),
  },
  plugins: [svelte({
    dynamicCompileOptions: () => ({ generate: "client" }),
  })],
  ssr: {
    noExternal: [
      "@comark/svelte",
      "bits-ui",
      "lucide-svelte",
      "runed",
      "svelte-toolbelt",
    ],
  },
  resolve: {
    conditions: ["browser"],
    alias: [
      {
        find: /^@dano\/types\//,
        replacement: typesRoot,
      },
    ],
  },
  test: {
    include: [
      "apps/dano/src/**/*.test.ts",
      "apps/dano/web/src/**/*.test.ts",
    ],
  },
});
