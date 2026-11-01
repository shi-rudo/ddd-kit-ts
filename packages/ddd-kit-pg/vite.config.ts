import { defineConfig } from "vite-plus";

export default defineConfig({
	test: {
		globalSetup: ["./test/postgres-container.ts"],
		// The first run pulls the PostgreSQL image.
		hookTimeout: 120_000,
	},
	pack: {
		entry: {
			index: "src/index.ts",
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
	},
});
