// Build script (not inline esbuild CLI flags) so the wasm-copy step is
// explicit and reviewable in one place, rather than buried in a
// package.json script string.
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist/pkg', { recursive: true });

await esbuild.build({
  entryPoints: ['src/main.jsx'],
  bundle: true,
  minify: true,
  sourcemap: true,
  format: 'esm',
  target: 'es2022',
  outfile: 'dist/app.js',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  logLevel: 'info',
});

copyFileSync('src/style.css', 'dist/app.css');

// @matrix-org/matrix-sdk-crypto-wasm's browser entry point (index.mjs,
// vendored into app.js by the bundle above) computes its own WASM URL at
// RUNTIME as `new URL("./pkg/matrix_sdk_crypto_wasm_bg.wasm",
// import.meta.url)` -- a hardcoded relative path baked into that package,
// not something esbuild rewrites (esbuild does NOT support the
// new-URL-as-asset-reference convention other bundlers like Vite/Webpack
// do -- confirmed empirically, not just from docs, before writing this).
// Since esbuild bundles everything into one flat app.js, `import.meta.url`
// at runtime resolves to wherever app.js itself was loaded from, so the
// wasm file just needs to exist at that same "./pkg/..." path relative to
// app.js for the hardcoded URL to resolve correctly -- no plugin, no
// custom loader, no code change to matrix-js-sdk's own init call needed.
copyFileSync(
  'node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/matrix_sdk_crypto_wasm_bg.wasm',
  'dist/pkg/matrix_sdk_crypto_wasm_bg.wasm',
);
