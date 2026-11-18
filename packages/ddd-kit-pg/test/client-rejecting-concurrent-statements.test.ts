import { Query } from "pg";
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

	it("accepts a Query object with a callback and frees itself when the callback fires", async () => {
		const rows = await new Promise((resolve, reject) => {
			client.query(
				new Query("SELECT 1 AS one", (failure, result) =>
					failure ? reject(failure) : resolve(result.rows),
				),
			);
		});
		const next = await client.query("SELECT 2 AS two");

		expect(rows).toEqual([{ one: 1 }]);
		expect(next.rows).toEqual([{ two: 2 }]);
	});

	it("rejects a statement that starts while a Query object runs", async () => {
		const running = new Promise((resolve) => {
			client.query(new Query("SELECT pg_sleep(0.05)", resolve));
		});

		await expect(client.query("SELECT 1")).rejects.toThrow(
			"a statement started while another statement of the client ran",
		);
		await running;
	});

	it("rejects a submittable before it sends it", async () => {
		const submittable = { submit: () => {} };

		expect(() => client.query(submittable as never)).toThrow(TypeError);
		const result = await client.query("SELECT 1 AS one");

		expect(result.rows).toEqual([{ one: 1 }]);
	});
});
