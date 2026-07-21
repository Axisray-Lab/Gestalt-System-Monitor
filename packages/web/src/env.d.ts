/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GSM_STATIC_REPLAYS?: 'rmuc2026-regionals';
  readonly VITE_GSM_E2E?: '1';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const component: DefineComponent<Record<string, never>, Record<string, never>, any>;
  export default component;
}
