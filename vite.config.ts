import { defaultExclude, defineConfig } from "vite-plus";

export default defineConfig({
	test: {
		// Keep repository copies out of the suite. A Stryker sandbox is left
		// behind when a mutation run crashes, and an agent worktree lives
		// under `.claude/`. Either one silently doubles every test and masks
		// the real counts.
		exclude: [...defaultExclude, ".stryker-tmp/**", ".claude/**"],
	},
	pack: {
		entry: {
			index: "src/index.ts",
			http: "src/presentation/http/problem-details.ts",
			money: "src/domain/value-object/money/index.ts",
			"public-errors": "src/presentation/errors/index.ts",
			testing: "src/testing/index.ts",
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
