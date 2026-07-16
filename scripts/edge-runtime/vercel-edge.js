import { runEdgeRuntimeSmoke } from "./smoke-operation.js";

addEventListener("fetch", (event) => {
	event.respondWith(
		(async () =>
			Response.json(await runEdgeRuntimeSmoke("vercel-edge-runtime")))(),
	);
});
