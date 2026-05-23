import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    utils: "src/utils.ts",
  },
  format: ["esm"], // ES modules only
  dts: true, // Generate .d.ts files
  splitting: false, // Libraries should not be split
  sourcemap: true, // Source maps for better debugging
  clean: true, // Clean dist folder before build
  minify: false, // Libraries ship unminified — the consumer's bundler handles minification
  treeshake: true, // Enable tree-shaking
  target: "es2022", // Matches tsconfig.json
  outDir: "dist", // Preserve module structure
  keepNames: true, // Do not bundle external dependencies (a library should leave its deps external)
  noExternal: [],
});
