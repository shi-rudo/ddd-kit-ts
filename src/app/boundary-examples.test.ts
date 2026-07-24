// @ts-expect-error Node's fs module exists in the test runtime; the package stays Node-type-free.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vite-plus/test";

const exampleUrls = {
	command: new URL("command.ts", import.meta.url),
	query: new URL("query.ts", import.meta.url),
	orderPlacement: new URL("order-placement-example.ts", import.meta.url),
	cqrsGuide: new URL("../../docs/guide/cqrs-and-buses.md", import.meta.url),
	edgeGuide: new URL("../../docs/guide/edge-runtimes.md", import.meta.url),
};

const examples = Object.values(exampleUrls).map((url) => ({
	url,
	source: readFileSync(url, "utf8"),
}));

const sourceOf = (name: keyof typeof exampleUrls): string =>
	readFileSync(exampleUrls[name], "utf8");

describe("untrusted-boundary examples", () => {
	it("never claim that a TypeScript assertion validates parsed input", () => {
		const unsafeAssertions = examples.flatMap(({ url, source }) =>
			findUnsafeBoundaryAssertions(source).map(
				(match) => `${url.pathname}: ${match}`,
			),
		);

		expect(unsafeAssertions).toEqual([]);
	});

	it("recognizes equivalent unsafe assertion forms", () => {
		const unsafeForms = [
			"const command = JSON.parse(body) as PlaceOrderCommand;",
			"const command = JSON.parse(body) as unknown as PlaceOrderCommand;",
			"const command: PlaceOrderCommand = JSON.parse(body);",
			"const query: GetOrderQuery = await request.json();",
			"const command = (await request.json()) as PlaceOrderCommand;",
			"const command: PlaceOrderCommand = (await request.json());",
			"const command = JSON.parse(body) satisfies PlaceOrderCommand;",
			"const raw = JSON.parse(body);\nconst command = raw as PlaceOrderCommand;",
			"const raw = await req.json();\nconst query: GetOrderQuery = raw;",
		];

		for (const source of unsafeForms) {
			expect(findUnsafeBoundaryAssertions(source), source).not.toEqual([]);
		}
	});

	it("keeps authenticated identity mapping separate from payload decoding", () => {
		const cqrsGuide = sourceOf("cqrsGuide");
		const edgeGuide = sourceOf("edgeGuide");

		expect(cqrsGuide).toContain("readonly customerId: CustomerId;");
		expect(cqrsGuide).not.toContain("customerIdFromPrincipal");
		expect(cqrsGuide).toContain('readonly category: "VALIDATION";');
		expect(cqrsGuide).toContain("readonly retryable: false;");
		expect(edgeGuide).toContain("readonly actorId: ActorId;");
		expect(edgeGuide).not.toContain("actorIdFromPrincipal");
		expect(edgeGuide).toContain('readonly category: "VALIDATION";');
		expect(edgeGuide).toContain("readonly retryable: false;");
	});

	it("renders the executable order-placement example in the CQRS guide", () => {
		const cqrsGuide = sourceOf("cqrsGuide");
		expect(cqrsGuide).toContain(
			"<<< ../../src/app/order-placement-example.ts#order-domain{ts}",
		);
		expect(cqrsGuide).toContain(
			"<<< ../../src/app/order-placement-example.ts#place-order-handler{ts}",
		);
	});

	it("shows atomic idempotency before settling an at-least-once command", () => {
		const cqrsGuide = sourceOf("cqrsGuide");
		const handler = sourceOf("orderPlacement");
		const consumer = sectionBetween(
			cqrsGuide,
			"interface QueueDelivery",
			"`QueueDelivery` is deliberately",
		);

		expect(consumer).toContain("readonly messageId: string;");
		expect(consumer).toContain(
			"const deliveryKey = scopedMessageKey(PLACE_ORDER_CONSUMER, messageId.value)",
		);
		expect(consumer).toContain("key: deliveryKey");
		expect(consumer).toContain("const intention: PlaceOrderIntention = {");
		expect(consumer).toContain('type: "PlaceOrder"');
		expect(consumer).toContain("fingerprint: stableHash(intention)");
		expect(handler).toContain("const outcome = await withIdempotentCommit<");
		expect(handler).toContain("command.idempotency");
		expectBefore(
			consumer,
			"await recordCommandOutcome(deliveryKey, outcome);",
			"delivery.ack();",
		);
	});

	it("handles command outcomes and query replies before acknowledging", () => {
		const commandDocs = sourceOf("command");
		const queryDocs = sourceOf("query");
		const commandConsumers = queueConsumerSnippets(commandDocs);
		const queryConsumers = queueConsumerSnippets(queryDocs);

		expect(commandConsumers).toHaveLength(2);
		for (const consumer of commandConsumers) {
			expect(consumer).toContain("decodeMessageId(");
			expect(consumer).toContain(
				"const deliveryKey = createOrderDeliveryKey(messageId.value);",
			);
			expect(consumer).toContain("executeIdempotentCreateOrder(");
			expectBefore(
				consumer,
				"executeIdempotentCreateOrder(",
				"await recordCommandOutcome(deliveryKey, outcome);",
			);
			expectBefore(
				consumer,
				"await recordCommandOutcome(deliveryKey, outcome);",
				"rabbitMQChannel.ack(",
			);
		}

		expect(queryConsumers).toHaveLength(2);
		for (const consumer of queryConsumers) {
			expectBefore(
				consumer,
				"const result = await ",
				"await publishQueryReply(",
			);
			expectBefore(
				consumer,
				"await publishQueryReply(",
				"rabbitMQChannel.ack(",
			);
		}
	});

	it("states that authenticated identity still requires use-case authorization", () => {
		const edgeGuide = sourceOf("edgeGuide");

		expect(edgeGuide).toMatch(
			/requestedBy[\s\S]{0,500}does\s+not\s+authorize[\s\S]{0,500}use case/i,
		);
		expect(edgeGuide).toContain("order.canBeConfirmedBy(command.requestedBy)");
		expect(edgeGuide).toContain('code: "FORBIDDEN"');
	});

	it("keeps permanent downstream outcomes out of the retryable failure", () => {
		const edgeGuide = sourceOf("edgeGuide");
		const classifier = sectionBetween(
			edgeGuide,
			"function isTransientOrderCommandStatus",
			"function createCommandBus",
		);
		const adapter = sectionBetween(
			edgeGuide,
			'bus.register("ConfirmOrder"',
			"return bus;",
		);

		expect(adapter).toContain("response.status === 404");
		expect(adapter).toContain('code: "ORDER_NOT_FOUND"');
		expect(adapter).toContain('category: "NOT_FOUND"');
		expect(adapter).toContain("response.status === 409");
		expect(adapter).toContain('code: "ORDER_STATE_CONFLICT"');
		expect(adapter).toContain('category: "CONFLICT"');
		expect(edgeGuide).toContain(
			"function isTransientOrderCommandStatus(status: number): boolean",
		);
		expect(classifier).toContain(
			"return status === 502 || status === 503 || status === 504;",
		);
		expect(classifier).not.toContain(">=");
		expect(adapter).toContain("isTransientOrderCommandStatus(response.status)");
		expect(adapter).not.toContain("response.status >= 500");
		expectBefore(
			adapter,
			"response.status === 409",
			"isTransientOrderCommandStatus(response.status)",
		);
		expect(adapter).toContain("Unexpected order command response");
		expect(edgeGuide).toContain("`502`, `503`, and `504`");
		expect(edgeGuide).toContain("`500`, `501`, and `505`");
	});

	it("makes an ambiguous downstream command retry idempotent", () => {
		const edgeGuide = sourceOf("edgeGuide");
		const requestHandler = sectionBetween(
			edgeGuide,
			"async fetch(request: Request",
			"async function readBoundedJson",
		);
		const decoder = sectionBetween(
			edgeGuide,
			"function decodeConfirmOrder",
			"function boundedId",
		);
		const useCase = sectionBetween(
			edgeGuide,
			"const confirmOrder = async",
			"This example keeps the bus",
		);

		expect(edgeGuide).toContain('type IdempotencyKey = Id<"IdempotencyKey">;');
		expect(edgeGuide).toContain(
			"readonly idempotency: IdempotentCommitRequest;",
		);
		expect(edgeGuide).toContain('request.headers.get("Idempotency-Key")');
		expect(requestHandler).toContain("idempotencyKeyFromHeader(");
		expectBefore(
			requestHandler,
			"idempotencyKeyFromHeader(",
			"decodeConfirmOrder(",
		);
		expect(decoder).toContain("const intention: ConfirmOrderIntention = {");
		expect(decoder).toContain(
			"scopedCommandKey(CONFIRM_ORDER_CONSUMER, principal.actorId, idempotencyKey)",
		);
		expect(decoder).toContain("fingerprint: stableHash(intention)");
		expect(edgeGuide).toContain("body: JSON.stringify(command)");
		expect(edgeGuide).toContain('"INVALID_IDEMPOTENCY_KEY"');
		expect(edgeGuide).toContain('"$header.Idempotency-Key"');
		expect(useCase).toContain("withIdempotentCommit(");
		expect(useCase).toContain("command.idempotency");
		expectBefore(
			useCase,
			"withIdempotentCommit(",
			"order.confirm(domainEvents.createFacts());",
		);
		expect(edgeGuide).toContain("type ConfirmOrderOutcome =");
		expect(useCase).toContain('status: "forbidden"');
		expect(useCase).toContain('status: "confirmed"');
		expect(useCase).not.toContain("result: err(");
		expect(useCase).not.toContain("result: ok(");
		expectBefore(
			useCase,
			"order.confirm(domainEvents.createFacts());",
			"commits: [enrollment.enrollSaved(order)]",
		);
		expect(useCase).toContain('outcome.result.status === "confirmed"');
		expect(useCase).toContain("return ok(outcome.result.orderId)");
		expect(edgeGuide).toContain("same stored outcome");
		expect(edgeGuide).toContain("atomically");
		expect(edgeGuide).toContain(
			"Retryability is a property of the failure, not permission to retry blindly",
		);
	});

	it("maps application failure categories to distinct HTTP statuses", () => {
		const edgeGuide = sourceOf("edgeGuide");
		const responseMapper = sectionBetween(
			edgeGuide,
			"function commandFailureResponse",
			"function requestFailure",
		);

		expect(responseMapper).toContain('case "FORBIDDEN"');
		expect(responseMapper).toContain('case "NOT_FOUND"');
		expect(responseMapper).toContain('case "CONFLICT"');
		expect(responseMapper).toContain('case "INFRASTRUCTURE"');
		expect(responseMapper).toContain("status: 403");
		expect(responseMapper).toContain("status: 404");
		expect(responseMapper).toContain("status: 409");
		expect(responseMapper).toContain("status: 503");
	});
});

function findUnsafeBoundaryAssertions(source: string): string[] {
	return typescriptSnippets(source).flatMap((snippet, index) => {
		const sourceFile = ts.createSourceFile(
			`boundary-example-${index}.ts`,
			snippet,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);
		const matches: string[] = [];
		const boundaryValues = new Set<string>();

		const visit = (node: ts.Node): void => {
			if (
				(ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) &&
				isCommandOrQueryType(node.type, sourceFile) &&
				containsBoundaryValue(node.expression, boundaryValues)
			) {
				matches.push(node.getText(sourceFile));
			} else if (
				ts.isVariableDeclaration(node) &&
				node.type !== undefined &&
				node.initializer !== undefined &&
				isCommandOrQueryType(node.type, sourceFile) &&
				containsBoundaryValue(node.initializer, boundaryValues)
			) {
				matches.push(node.getText(sourceFile));
			}

			if (
				ts.isVariableDeclaration(node) &&
				ts.isIdentifier(node.name) &&
				node.initializer !== undefined &&
				containsBoundaryValue(node.initializer, boundaryValues)
			) {
				boundaryValues.add(node.name.text);
			} else if (
				ts.isBinaryExpression(node) &&
				node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
				ts.isIdentifier(node.left) &&
				containsBoundaryValue(node.right, boundaryValues)
			) {
				boundaryValues.add(node.left.text);
			}
			ts.forEachChild(node, visit);
		};

		visit(sourceFile);
		return matches;
	});
}

function sectionBetween(source: string, start: string, end: string): string {
	const startAt = source.indexOf(start);
	const endAt = source.indexOf(end, startAt);
	return source.slice(startAt, endAt);
}

function expectBefore(source: string, before: string, after: string): void {
	const beforeAt = source.indexOf(before);
	const afterAt = source.indexOf(after);
	expect(beforeAt, `missing before marker: ${before}`).toBeGreaterThanOrEqual(
		0,
	);
	expect(afterAt, `missing after marker: ${after}`).toBeGreaterThanOrEqual(0);
	expect(beforeAt, `${before} must precede ${after}`).toBeLessThan(afterAt);
}

function queueConsumerSnippets(source: string): string[] {
	return fencedTypescriptSnippets(source).filter((snippet) =>
		snippet.includes("rabbitMQChannel.consume("),
	);
}

function typescriptSnippets(source: string): string[] {
	const fenced = fencedTypescriptSnippets(source);
	if (source.trimStart().startsWith("#")) return fenced;
	return [source, ...fenced];
}

function fencedTypescriptSnippets(source: string): string[] {
	return [
		...source.matchAll(
			/^[ \t]*(?:\*\s*)?```(?:ts|typescript)\s*\r?\n([\s\S]*?)^[ \t]*(?:\*\s*)?```/gim,
		),
	].map((match) => (match[1] ?? "").replace(/^[ \t]*\* ?/gm, ""));
}

function isCommandOrQueryType(
	type: ts.TypeNode,
	sourceFile: ts.SourceFile,
): boolean {
	return /(?:Command|Query)\b/.test(type.getText(sourceFile));
}

function containsBoundaryValue(
	node: ts.Node,
	boundaryValues: ReadonlySet<string>,
): boolean {
	let found = false;
	const visit = (candidate: ts.Node): void => {
		if (
			isBoundaryParserCall(candidate) ||
			(ts.isIdentifier(candidate) && boundaryValues.has(candidate.text))
		) {
			found = true;
			return;
		}
		if (!found) ts.forEachChild(candidate, visit);
	};
	visit(node);
	return found;
}

function isBoundaryParserCall(node: ts.Node): boolean {
	if (
		!ts.isCallExpression(node) ||
		!ts.isPropertyAccessExpression(node.expression)
	) {
		return false;
	}
	const owner = node.expression.expression;
	const method = node.expression.name.text;
	return (
		(ts.isIdentifier(owner) && owner.text === "JSON" && method === "parse") ||
		method === "json"
	);
}
