import {
	afterEach,
	beforeEach,
	describe,
	expect,
	inject,
	it,
} from "vite-plus/test";
import { ClientRejectingConcurrentStatements } from "./client-rejecting-concurrent-statements";

describe("ClientRejectingConcurrentStatements", () => {
	let client: ClientRejectingConcurrentStatements;

	beforeEach(async () => {
		client = new ClientRejectingConcurrentStatements({
			connectionString: inject("postgresUri"),
		});
		await client.connect();
	});

	afterEach(() => client.end());

	it("rejects a statement that starts while another statement runs", async () => {
		const running = client.query("SELECT pg_sleep(0.05)");

		await expect(client.query("SELECT 1")).rejects.toThrow(
			"a statement started while another statement of the client ran",
		);
		await running;
	});

	it("accepts the next statement after a statement that throws at once", async () => {
		expect(() => client.query(null as unknown as string)).toThrow();

		const result = await client.query("SELECT 1 AS one");

		expect(result.rows).toEqual([{ one: 1 }]);
	});
});
