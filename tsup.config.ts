import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    utils: "src/utils.ts",
    http: "src/http.ts",
    money: "src/money.ts",
    presentation: "src/presentation.ts",
    testing: "src/testing.ts",
  },
  format: ["esm"], // ES modules only
  dts: {
    // tsup 8.5.1 injects the deprecated `baseUrl` option into its declaration
    // worker even though this project does not configure it. Keep the
    // suppression local to that TypeScript 6 compatibility-API path; the
    // TypeScript 7 project typecheck remains unsuppressed.
    compilerOptions: { ignoreDeprecations: "6.0" },
  },
  splitting: false, // Libraries should not be split
  sourcemap: true, // Source maps for better debugging
  clean: true, // Clean dist folder before build
  minify: false, // Libraries ship unminified; the consumer's bundler handles minification
  treeshake: true, // Enable tree-shaking
  target: "es2022", // Matches tsconfig.json
  outDir: "dist",
  keepNames: true, // Preserve class/function names (error-name matching relies on them)
  noExternal: [], // Do not bundle external dependencies (a library leaves its deps external)
});
