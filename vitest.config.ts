import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Keep Stryker sandboxes (left behind when a mutation run crashes)
		// out of the suite; a leftover copy would silently double every
		// test and mask real counts.
		exclude: [...defaultExclude, ".stryker-tmp/**"],
	},
});
