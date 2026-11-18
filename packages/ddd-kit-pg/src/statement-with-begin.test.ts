import { Client, Query } from "pg";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	inject,
	it,
} from "vite-plus/test";
import { countRoundTrips } from "../test/round-trips";
import {
	canSendStatementWithBegin,
	sendStatementWithBegin,
} from "./statement-with-begin";

class ClientReportingNoTransaction extends Client {
	override getTransactionStatus() {
		return "I" as const;
	}
}

describe("sendStatementWithBegin", () => {
	let client: Client;
	let roundTrips: () => number;

	const connect = async (ClientClass: typeof Client) => {
		client = new ClientClass({ connectionString: inject("postgresUri") });
		await client.connect();
		await client.query("CREATE TEMP TABLE note (body text NOT NULL)");
		roundTrips = countRoundTrips(client);
	};

	const noteCount = async () => {
		const { rows } = await client.query(
			"SELECT count(*)::int AS count FROM note",
		);
		return rows[0].count;
	};

	beforeEach(() => connect(Client));

	afterEach(() => client.end());

	it("sends BEGIN and the statement in one round trip", async () => {
		const outcome = await sendStatementWithBegin(
			client,
			"BEGIN",
			"INSERT INTO note VALUES ($1) RETURNING body",
			["first"],
		);

		expect(roundTrips()).toBe(1);
		expect(outcome).toMatchObject({
			beginConfirmed: true,
			statement: {
				result: { command: "INSERT", rowCount: 1, rows: [{ body: "first" }] },
			},
		});
	});

	it("runs the statement in the transaction that BEGIN opened", async () => {
		await sendStatementWithBegin(
			client,
			"BEGIN",
			"INSERT INTO note VALUES ($1)",
			["first"],
		);
		await client.query("ROLLBACK");

		expect(await noteCount()).toBe(0);
	});

	it("opens the transaction with the given BEGIN statement", async () => {
		const outcome = await sendStatementWithBegin(
			client,
			"BEGIN ISOLATION LEVEL SERIALIZABLE",
			"SELECT current_setting('transaction_isolation') AS level, $1::int",
			[1],
		);

		expect(outcome).toMatchObject({
			statement: { result: { rows: [{ level: "serializable" }] } },
		});
	});

	it.each([
		["does not parse", "BEGIN ISOLATION LEVEL NONSENSE", "42601"],
		[
			"fails when PostgreSQL runs it",
			"DO $$ BEGIN RAISE EXCEPTION 'no transaction'; END $$",
			"P0001",
		],
	])(
		"does not run the statement when BEGIN %s",
		async (_case, begin, sqlState) => {
			const outcome = await sendStatementWithBegin(
				client,
				begin,
				"INSERT INTO note VALUES ($1)",
				["first"],
			);

			expect(outcome).toMatchObject({
				beginConfirmed: false,
				failure: { code: sqlState },
			});
			expect(await noteCount()).toBe(0);
		},
	);

	it("reports a failed statement after a confirmed BEGIN", async () => {
		const outcome = await sendStatementWithBegin(
			client,
			"BEGIN",
			"SELECT 1 / $1::int",
			[0],
		);

		expect(outcome).toMatchObject({
			beginConfirmed: true,
			statement: { failure: { code: "22012" } },
		});
		await expect(client.query("SELECT 1")).rejects.toMatchObject({
			code: "25P02",
		});
	});

	it("reports an unconfirmed BEGIN when a value of the statement does not serialize", async () => {
		const circular: { self?: unknown } = {};
		circular.self = circular;

		const outcome = await sendStatementWithBegin(
			client,
			"BEGIN",
			"INSERT INTO note VALUES ($1)",
			[circular],
		);

		expect(outcome).toMatchObject({
			beginConfirmed: false,
			failure: expect.any(TypeError),
		});
	});

	it("reports an unconfirmed BEGIN when the client reports no open transaction after it", async () => {
		await client.end();
		await connect(ClientReportingNoTransaction);

		const outcome = await sendStatementWithBegin(
			client,
			"BEGIN",
			"INSERT INTO note VALUES ($1)",
			["first"],
		);

		expect(outcome).toMatchObject({
			beginConfirmed: false,
			failure: expect.any(Error),
		});
	});
});

describe("canSendStatementWithBegin", () => {
	it("accepts the JavaScript client of pg", () => {
		expect(canSendStatementWithBegin(new Client())).toBe(true);
	});

	it("rejects a client that is not the JavaScript client of pg", () => {
		const client = { query: async () => ({ rows: [] }) };

		expect(canSendStatementWithBegin(client)).toBe(false);
	});

	it("rejects a client that cannot report its transaction status", () => {
		const client = Object.assign(new Client(), {
			getTransactionStatus: undefined,
		});

		expect(canSendStatementWithBegin(client)).toBe(false);
	});

	it("rejects a driver whose Query does not handle CommandComplete", () => {
		const driverQuery = Query.prototype as unknown as {
			handleCommandComplete: unknown;
		};
		const handler = driverQuery.handleCommandComplete;
		driverQuery.handleCommandComplete = undefined;

		const accepted = canSendStatementWithBegin(new Client());
		driverQuery.handleCommandComplete = handler;

		expect(accepted).toBe(false);
	});
});
