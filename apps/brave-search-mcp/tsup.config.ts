import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  minify: 'terser',
  terserOptions: {
    compress: { passes: 2 },
    mangle: { toplevel: true },
  },
  sourcemap: false,
  clean: true,
  splitting: false,
  dts: false,
  shims: true,
  // The published/runtime artifact is intentionally standalone. The Incus
  // deployment copies only dist/index.js and does not carry node_modules.
  noExternal: [/.+/],
  banner: {
    js: 'import { createRequire as __createRequire } from "module";\nconst require = __createRequire(import.meta.url);',
  },
});
