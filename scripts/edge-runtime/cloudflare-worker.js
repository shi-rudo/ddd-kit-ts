import { runEdgeRuntimeSmoke } from "./smoke-operation.js";

export default {
	async fetch() {
		return Response.json(await runEdgeRuntimeSmoke("cloudflare-workerd"));
	},
};
