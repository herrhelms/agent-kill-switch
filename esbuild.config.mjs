// esbuild.config.mjs — three build targets for the Kill Switch plugin.
//
//   dist/worker.js    — worker entry (Node/host runtime)
//   dist/manifest.js  — plugin manifest (Node/host runtime)
//   dist/ui/index.js  — UI bundle (browser); entrypoints.ui is a DIRECTORY
//
// The SDK and React are provided by the host at runtime, so they are marked
// external and never bundled. Run `node esbuild.config.mjs` to build once, or
// `node esbuild.config.mjs --watch` to rebuild on change.

import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

const externals = [
  "@paperclipai/plugin-sdk",
  "@paperclipai/plugin-sdk/ui",
  "react",
  "react-dom",
  "react/jsx-runtime",
  "react-dom/client",
];

/** @type {import('esbuild').BuildOptions[]} */
const targets = [
  {
    entryPoints: ["src/worker.ts"],
    outfile: "dist/worker.js",
    platform: "node",
    format: "esm",
    target: "node22",
    bundle: true,
    sourcemap: true,
    external: externals,
  },
  {
    entryPoints: ["src/manifest.ts"],
    outfile: "dist/manifest.js",
    platform: "node",
    format: "esm",
    target: "node22",
    bundle: true,
    sourcemap: true,
    external: externals,
  },
  {
    entryPoints: ["src/ui/index.tsx"],
    outfile: "dist/ui/index.js",
    platform: "browser",
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    bundle: true,
    sourcemap: true,
    external: externals,
  },
];

if (watch) {
  const contexts = await Promise.all(targets.map((t) => context(t)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("esbuild: watching worker + manifest + ui …");
} else {
  await Promise.all(targets.map((t) => build(t)));
  console.log("esbuild: built worker + manifest + ui");
}
