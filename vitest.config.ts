import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

const typesRoot = fileURLToPath(new URL("./apps/dano/types/", import.meta.url));
const webSrcRoot = fileURLToPath(new URL("./apps/dano/web/src/", import.meta.url));

export default defineConfig({
  plugins: [svelte({
    dynamicCompileOptions: () => ({ generate: "client" }),
  })],
  ssr: {
    noExternal: [
      "@comark/svelte",
      "@lucide/svelte",
      "bits-ui",
      "runed",
      "svelte-toolbelt",
    ],
  },
  resolve: {
    conditions: ["browser"],
    alias: [
      {
        find: /^\$lib(?:\/(.*))?$/,
        replacement: `${webSrcRoot}$1`,
      },
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
