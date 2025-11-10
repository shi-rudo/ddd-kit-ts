import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"], // ES Modules only (wie aktuell)
	dts: true, // Generate .d.ts files
	splitting: false, // Library sollte nicht gesplittet werden
	sourcemap: true, // Source maps für besseres Debugging
	clean: true, // Clean dist folder before build
	minify: true, // Minify output for smaller bundle size
	treeshake: true, // Tree-shaking aktivieren
	target: "es2022", // Wie in tsconfig.json
	outDir: "dist",
	// Preserve die Struktur der Module
	keepNames: true,
	// Keine externen Dependencies bundlen (Library sollte dependencies nicht bundlen)
	noExternal: [],
});

