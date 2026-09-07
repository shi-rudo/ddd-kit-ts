// @ts-expect-error Node's url module exists in the test runtime; the package stays Node-type-free.
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vite-plus/test";

/**
 * Compiles one call per constraint of the two repository wiring sites through
 * the TypeScript compiler API. The sites are `defineRepository` and the
 * `repositories` of `UnitOfWork`. The suite reads the diagnostic that a
 * consumer sees. A `@ts-expect-error` proves only that some error exists;
 * this suite pins the text that names the violated constraint.
 */

const moduleDirectory: string = fileURLToPath(new URL("./", import.meta.url));
const repositoryRoot: string = fileURLToPath(
	new URL("../../../", import.meta.url),
);

const probePrelude = `
import type { Version } from "../../domain/aggregate/aggregate";
import { StateStoredAggregate } from "../../domain/aggregate/state-stored-aggregate";
import type { DomainEvent } from "../../domain/event/domain-event";
import type { Id } from "../../domain/identity/id";
import { InfrastructureError } from "../../errors/kit-errors";
import type { Outbox } from "../../messaging/outbox/ports";
import type { PersistenceModel } from "../../persistence/repository/persistence-model";
import type { TransactionScope } from "../../persistence/repository/scope";
import type { RepositoryTracking } from "./persistence-contract";
import { defineRepository, UnitOfWork } from "./unit-of-work";

type OrderEvent = DomainEvent<"OrderPlaced", { readonly orderId: string }>;
type OrderId = Id<"OrderId">;

class Order extends StateStoredAggregate<
	Readonly<Record<string, never>>,
	OrderId,
	OrderEvent
> {
	protected readonly aggregateType = "Order";
	constructor(id: OrderId) {
		super(id, {});
	}
}

class OrderStoreUnavailableError extends InfrastructureError<"ORDER_STORE_UNAVAILABLE"> {
	constructor(cause: unknown) {
		super({
			code: "ORDER_STORE_UNAVAILABLE",
			message: "The order store is unavailable",
			cause,
			retryable: true,
		});
	}
}

const persistence: PersistenceModel<Order, Version, Version | undefined> = {
	capture: (order) => order.version,
	changes: (baseline, order) =>
		baseline === order.version ? undefined : order.version,
	isEmpty: (change) => change === undefined,
};

class SqlOrderAdapter {
	constructor(readonly _tracking: RepositoryTracking<Order>) {}
	async findById(_id: OrderId): Promise<Order | null> {
		return null;
	}
}

interface ForStoringOrders {
	findById(id: OrderId): Promise<Order | null>;
	add(order: Order): void;
	update(order: Order): void;
}

interface ForRemovingOrders extends ForStoringOrders {
	remove(order: Order): void;
}

interface ForAppendingOrders {
	findById(id: OrderId): Promise<Order | null>;
	add(order: Order): void;
}

interface ForAppendingAndRemovingOrders extends ForAppendingOrders {
	remove(order: Order): void;
}

interface ForReadingOrders {
	findById(id: OrderId): Promise<Order | null>;
}

interface ForStoringOrdersWithOptionalUpdate extends ForAppendingOrders {
	update?(order: Order): void;
}

interface ForRemovingOrdersWithOptionalRemove extends ForStoringOrders {
	remove?(order: Order): void;
}

interface ForRemovingOrdersById extends ForStoringOrders {
	remove(id: OrderId): void;
}

type PaymentEvent = DomainEvent<"PaymentCaptured", { readonly paymentId: string }>;

class Payment extends StateStoredAggregate<
	Readonly<Record<string, never>>,
	OrderId,
	PaymentEvent
> {
	protected readonly aggregateType = "Payment";
	constructor(id: OrderId) {
		super(id, {});
	}
}

interface ForStoringPayments {
	findById(id: OrderId): Promise<Order | null>;
	add(payment: Payment): void;
	update(payment: Payment): void;
}

declare const removalFlag: boolean;
declare const appendOnlyFlag: boolean;

const paymentPersistence: PersistenceModel<Payment, Version, Version | undefined> = {
	capture: (payment) => payment.version,
	changes: (baseline, payment) =>
		baseline === payment.version ? undefined : payment.version,
	isEmpty: (change) => change === undefined,
};

declare const scope: TransactionScope<undefined>;
declare const outbox: Outbox<OrderEvent>;
declare const tracking: RepositoryTracking<Order>;

const orders = defineRepository<ForStoringOrders>()({
	aggregate: Order,
	persistence,
	create: (_transaction: undefined, tracking) => new SqlOrderAdapter(tracking),
	flush: async () => {},
	mapError: (error) => new OrderStoreUnavailableError(error),
});

const unbrandedOrders = {
	aggregate: Order,
	persistence,
	create: (_transaction: undefined, tracking: RepositoryTracking<Order>) =>
		new SqlOrderAdapter(tracking),
	flush: async () => {},
	mapError: (error: unknown) => new OrderStoreUnavailableError(error),
};

const connectionOrders = defineRepository<ForStoringOrders>()({
	aggregate: Order,
	persistence,
	create: (_transaction: { readonly connection: string }, tracking) =>
		new SqlOrderAdapter(tracking),
	flush: async (_transaction: { readonly connection: string }) => {},
	mapError: (error) => new OrderStoreUnavailableError(error),
});

const payments = defineRepository<ForStoringPayments>()({
	aggregate: Payment,
	persistence: paymentPersistence,
	create: () => ({ findById: async () => null }),
	flush: async (_transaction: undefined) => {},
	mapError: (error) => new OrderStoreUnavailableError(error),
});
`;

const adapterWiring = `
	aggregate: Order,
	persistence,
	create: (_transaction: undefined, tracking) => new SqlOrderAdapter(tracking),
	flush: async () => {},
	mapError: (error) => new OrderStoreUnavailableError(error),
`;

const probes = {
	"complete-port": `defineRepository<ForStoringOrders>()({${adapterWiring}});`,
	"complete-port-with-removal": `defineRepository<ForRemovingOrders>()({
	physicalRemoval: true,${adapterWiring}});`,
	"any-port": `defineRepository<any>()({${adapterWiring}});`,
	"append-only-port": `defineRepository<ForAppendingOrders>()({
	appendOnly: true,${adapterWiring}});`,
	"append-only-port-with-removal": `defineRepository<ForAppendingAndRemovingOrders>()({
	appendOnly: true,
	physicalRemoval: true,${adapterWiring}});`,
	"port-without-update": `defineRepository<ForAppendingOrders>()({${adapterWiring}});`,
	"append-only-with-update": `defineRepository<ForStoringOrders>()({
	appendOnly: true,${adapterWiring}});`,
	"append-only-with-boolean-flag": `defineRepository<ForAppendingOrders>()({
	appendOnly: appendOnlyFlag,${adapterWiring}});`,
	"update-with-boolean-append-only": `defineRepository<ForStoringOrders>()({
	appendOnly: appendOnlyFlag,${adapterWiring}});`,
	"optional-update": `defineRepository<ForStoringOrdersWithOptionalUpdate>()({${adapterWiring}});`,
	"optional-remove": `defineRepository<ForRemovingOrdersWithOptionalRemove>()({
	physicalRemoval: true,${adapterWiring}});`,
	"port-without-add": `defineRepository<ForReadingOrders>()({${adapterWiring}});`,
	"port-for-another-aggregate": `defineRepository<ForStoringPayments>()({${adapterWiring}});`,
	"removal-without-remove": `defineRepository<ForStoringOrders>()({
	physicalRemoval: true,${adapterWiring}});`,
	"remove-without-removal": `defineRepository<ForRemovingOrders>()({${adapterWiring}});`,
	"remove-with-boolean-removal": `defineRepository<ForRemovingOrders>()({
	physicalRemoval: removalFlag,${adapterWiring}});`,
	"remove-by-id": `defineRepository<ForRemovingOrdersById>()({
	physicalRemoval: true,${adapterWiring}});`,
	"union-port": `defineRepository<ForStoringOrders | ForRemovingOrders>()({${adapterWiring}});`,
	"callable-port": `defineRepository<(required: string) => void>()({${adapterWiring}});`,
	"compatible-definition": `new UnitOfWork({ scope, outbox, repositories: { orders } })
	.run(async ({ repositories }) => {
		const port: ForStoringOrders = repositories.orders;
		void port;
	});`,
	"raw-adapter": `new UnitOfWork({ scope, outbox, repositories: { orders: new SqlOrderAdapter(tracking) } });`,
	"unbranded-definition": `new UnitOfWork({ scope, outbox, repositories: { orders: unbrandedOrders } });`,
	"definition-with-another-context": `new UnitOfWork({ scope, outbox, repositories: { orders: connectionOrders } });`,
	"unbranded-definition-used-in-run": `new UnitOfWork({ scope, outbox, repositories: { orders: unbrandedOrders } })
	.run(async ({ repositories }) => {
		await repositories.orders.findById("order-1" as OrderId);
	});`,
	"definition-with-another-event-family": `new UnitOfWork({ scope, outbox, repositories: { payments } });`,
	"compatible-and-incompatible-definitions": `new UnitOfWork({ scope, outbox, repositories: { orders, payments } });`,
} as const;

type ProbeName = keyof typeof probes;

const probePath = (name: ProbeName): string =>
	`${moduleDirectory}repository-wiring.${name}.probe.ts`;

function compileProbes(): ts.Program {
	const configPath = `${repositoryRoot}tsconfig.json`;
	const config = ts.readConfigFile(configPath, ts.sys.readFile);
	if (config.error !== undefined) {
		throw new Error(
			ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
		);
	}
	const { options, errors } = ts.parseJsonConfigFileContent(
		config.config,
		ts.sys,
		repositoryRoot,
	);
	if (errors.length > 0) {
		throw new Error(
			errors
				.map((error) =>
					ts.flattenDiagnosticMessageText(error.messageText, "\n"),
				)
				.join("\n"),
		);
	}
	const probeOptions: ts.CompilerOptions = {
		...options,
		noEmit: true,
		declaration: false,
	};
	const sources = new Map(
		(Object.keys(probes) as ProbeName[]).map((name) => [
			probePath(name),
			`${probePrelude}\n${probes[name]}\n`,
		]),
	);
	const host = ts.createCompilerHost(probeOptions);
	const diskFileExists = host.fileExists;
	const diskReadFile = host.readFile;
	const diskGetSourceFile = host.getSourceFile;
	host.fileExists = (fileName) =>
		sources.has(fileName) || diskFileExists(fileName);
	host.readFile = (fileName) => sources.get(fileName) ?? diskReadFile(fileName);
	host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
		const source = sources.get(fileName);
		return source === undefined
			? diskGetSourceFile(fileName, languageVersion, onError, shouldCreate)
			: ts.createSourceFile(fileName, source, languageVersion, true);
	};
	return ts.createProgram({
		rootNames: [...sources.keys()],
		options: probeOptions,
		host,
	});
}

let compiled: ts.Program | undefined;

interface ProbeDiagnostic {
	readonly message: string;
	/** The source text that the diagnostic points at; absent for a file-level diagnostic. */
	readonly target: string | undefined;
}

function diagnosticsOf(name: ProbeName): ProbeDiagnostic[] {
	compiled ??= compileProbes();
	const sourceFile = compiled.getSourceFile(probePath(name));
	if (sourceFile === undefined) {
		throw new Error(`probe ${name} did not enter the program`);
	}
	return [
		...compiled.getSyntacticDiagnostics(sourceFile),
		...compiled.getSemanticDiagnostics(sourceFile),
	].map((diagnostic) => ({
		message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
		target:
			diagnostic.start === undefined
				? undefined
				: sourceFile.text.slice(
						diagnostic.start,
						diagnostic.start + (diagnostic.length ?? 0),
					),
	}));
}

describe("defineRepository compile-time diagnostics", () => {
	it("accepts a port that declares add and update", () => {
		expect(diagnosticsOf("complete-port")).toEqual([]);
	});

	it("accepts a port with remove when physicalRemoval is true", () => {
		expect(diagnosticsOf("complete-port-with-removal")).toEqual([]);
	});

	it("accepts a port typed any", () => {
		expect(diagnosticsOf("any-port")).toEqual([]);
	});

	it("accepts a port without update when appendOnly is true", () => {
		expect(diagnosticsOf("append-only-port")).toEqual([]);
	});

	it("accepts an append-only port with remove when physicalRemoval is true", () => {
		expect(diagnosticsOf("append-only-port-with-removal")).toEqual([]);
	});

	it.each([
		[
			"port-without-update",
			"the port declares no update, so the definition must set appendOnly: true",
		],
		[
			"append-only-with-update",
			"appendOnly is true, so the port must not declare update",
		],
		[
			"append-only-with-boolean-flag",
			"the port declares no update, so the definition must set appendOnly: true",
		],
		[
			"update-with-boolean-append-only",
			"the port declares update, so the definition must not set appendOnly",
		],
		["optional-update", "the port's update must not be optional"],
		["optional-remove", "the port's remove must not be optional"],
		["port-without-add", "the port must declare add(aggregate): void"],
		[
			"port-for-another-aggregate",
			"the port's add must accept the definition's aggregate",
		],
		[
			"removal-without-remove",
			"physicalRemoval is true, so the port must declare remove(aggregate): void",
		],
		[
			"remove-without-removal",
			"the port declares remove, so the definition must set physicalRemoval: true",
		],
		[
			"remove-with-boolean-removal",
			"the port declares remove, so the definition must set physicalRemoval: true",
		],
		[
			"remove-by-id",
			"the port's remove must accept the definition's aggregate",
		],
		["union-port", "the port must be one object type, not a union"],
		["callable-port", "the port must be an object type, not a function"],
	] as const)(
		"reports one error that names the violated constraint for %s",
		(name, constraint) => {
			const diagnostics = diagnosticsOf(name);

			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]?.message).toContain(
				`Property '"defineRepository: ${constraint}"' is missing`,
			);
		},
	);
});

describe("UnitOfWork repositories compile-time diagnostics", () => {
	it("accepts a compatible definition and exposes its port", () => {
		expect(diagnosticsOf("compatible-definition")).toEqual([]);
	});

	it.each([
		[
			"raw-adapter",
			"the repository must be a definition from defineRepository",
		],
		[
			"unbranded-definition",
			"the repository must be a definition from defineRepository",
		],
		[
			"definition-with-another-context",
			"the definition's transaction context must accept the scope's context",
		],
		[
			"definition-with-another-event-family",
			"the outbox must accept the definition's aggregate events",
		],
	] as const)(
		"reports one error that names the violated constraint for %s",
		(name, constraint) => {
			const diagnostics = diagnosticsOf(name);

			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]?.message).toContain(
				`Property '"UnitOfWork: ${constraint}"' is missing`,
			);
		},
	);

	it("names the constraint again where run() uses the rejected entry", () => {
		const diagnostics = diagnosticsOf("unbranded-definition-used-in-run");

		expect(diagnostics).toHaveLength(2);
		expect(diagnostics[0]?.message).toContain(
			`Property '"UnitOfWork: the repository must be a definition from defineRepository"' is missing`,
		);
		expect(diagnostics[1]?.message).toBe(
			`Property 'findById' does not exist on type 'RepositoryWiringViolation<"the repository must be a definition from defineRepository">'.`,
		);
	});

	it("points the error at the incompatible entry, not at the record", () => {
		const diagnostics = diagnosticsOf(
			"compatible-and-incompatible-definitions",
		);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.target).toBe("payments");
		expect(diagnostics[0]?.message).toContain(
			`Property '"UnitOfWork: the outbox must accept the definition's aggregate events"' is missing`,
		);
	});
});
