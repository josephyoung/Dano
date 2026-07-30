/// <reference types="svelte" />
/// <reference types="vite/client" />

import type { BridgeBrowserRuntimeConfig } from "@dano/types/protocol";

declare global {
  const __DANO_DEFAULT_PRODUCT_NAME__: string;
  const __PI_WEB_DEV_DEBUG__: boolean;

  interface Window {
    __PI_WEB_CONFIG__?: BridgeBrowserRuntimeConfig;
  }
}

export {};
