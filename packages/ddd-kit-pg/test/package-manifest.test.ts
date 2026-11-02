import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const manifest = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

describe("the package manifest", () => {
	it("takes the kit as a peer, so a consumer loads one copy of the kit", () => {
		expect(manifest.peerDependencies["@shirudo/ddd-kit"]).toBeDefined();
		expect(manifest.dependencies?.["@shirudo/ddd-kit"]).toBeUndefined();
	});
});
