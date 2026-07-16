import { defaultExclude, defineConfig } from "vite-plus";

export default defineConfig({
	test: {
		// Keep Stryker sandboxes (left behind when a mutation run crashes)
		// out of the suite; a leftover copy would silently double every
		// test and mask real counts.
		exclude: [...defaultExclude, ".stryker-tmp/**"],
	},
	pack: {
		entry: {
			index: "src/index.ts",
			utils: "src/utils.ts",
			http: "src/http.ts",
			money: "src/money.ts",
			presentation: "src/presentation.ts",
			testing: "src/testing.ts",
		},
		format: ["esm"],
		dts: true,
		sourcemap: true,
		clean: true,
		minify: false,
		treeshake: true,
		target: "es2022",
		outDir: "dist",
		fixedExtension: false,
		hash: false,
		outputOptions: {
			// Keep internal chunks away from public entry-point filenames.
			chunkFileNames: "chunks/[name].js",
		},
	},
});
