/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional API base URL (default "/api", proxied to the backend by the Vite dev server). */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Monaco "editor core" entry (all editor features, no bundled language services).
 * It has no .d.ts of its own; it exports exactly the editor.api surface.
 */
declare module 'monaco-editor/esm/vs/editor/edcore.main' {
  export * from 'monaco-editor/esm/vs/editor/editor.api';
}
