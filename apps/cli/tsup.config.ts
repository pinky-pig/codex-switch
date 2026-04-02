import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/cli.tsx"],
    format: ["esm"],
    dts: true,
    clean: true,
    noExternal: [],
  },
  {
    entry: ["src/app-runtime.ts"],
    format: ["esm"],
    outDir: "dist",
    clean: false,
    noExternal: [],
  },
]);
