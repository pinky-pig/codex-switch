import { defineConfig } from "tsup";

const bundledDeps = ["commander", "ink", "react"];

export default defineConfig([
  {
    entry: ["src/cli.tsx"],
    format: ["esm"],
    dts: true,
    clean: true,
    noExternal: bundledDeps,
  },
  {
    entry: ["src/app-runtime.ts"],
    format: ["esm"],
    outDir: "dist",
    clean: false,
    noExternal: bundledDeps,
  },
]);
