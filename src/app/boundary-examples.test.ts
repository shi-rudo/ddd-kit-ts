// @ts-expect-error Node's fs module exists in the test runtime; the package stays Node-type-free.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vite-plus/test";

const exampleUrls = {
	command: new URL("command.ts", import.meta.url),
	query: new URL("query.ts", import.meta.url),
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

	it("shows atomic idempotency before settling an at-least-once command", () => {
		const cqrsGuide = sourceOf("cqrsGuide");
		const consumer = sectionBetween(
			cqrsGuide,
			"interface QueueDelivery",
			"`QueueDelivery` is deliberately",
		);
		const handler = sectionBetween(
			cqrsGuide,
			"const placeOrderHandler",
			"A command handler returns",
		);

		expect(consumer).toContain("readonly messageId: string;");
		expect(consumer).toContain("key: messageId.value");
		expect(consumer).toContain("fingerprint: stableHash(decoded.value)");
		expect(handler).toContain("withIdempotentCommit(");
		expect(handler).toContain("cmd.idempotency");
		expect(consumer).toContain(
			"recordCommandOutcome(messageId.value, outcome)",
		);
		expect(consumer.indexOf("recordCommandOutcome")).toBeLessThan(
			consumer.indexOf("delivery.ack()"),
		);
	});

	it("handles command outcomes and query replies before acknowledging", () => {
		const commandDocs = sourceOf("command");
		const queryDocs = sourceOf("query");

		expect(commandDocs).toContain(
			"const outcome = await handler(decoded.value);",
		);
		expect(commandDocs).toContain("await recordCommandOutcome(outcome);");
		expect(queryDocs).toContain("const result = await handler(decoded.value);");
		expect(queryDocs).toContain("await publishQueryReply(message, result);");
	});

	it("states that authenticated identity still requires use-case authorization", () => {
		const edgeGuide = sourceOf("edgeGuide");

		expect(edgeGuide).toMatch(
			/requestedBy[\s\S]{0,500}does\s+not\s+authorize[\s\S]{0,500}use case/i,
		);
		expect(edgeGuide).toContain("order.canBeConfirmedBy(command.requestedBy)");
		expect(edgeGuide).toContain('code: "FORBIDDEN"');
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

		const visit = (node: ts.Node): void => {
			if (
				(ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) &&
				isCommandOrQueryType(node.type, sourceFile) &&
				containsBoundaryParser(node.expression)
			) {
				matches.push(node.getText(sourceFile));
			} else if (
				ts.isVariableDeclaration(node) &&
				node.type !== undefined &&
				node.initializer !== undefined &&
				isCommandOrQueryType(node.type, sourceFile) &&
				containsBoundaryParser(node.initializer)
			) {
				matches.push(node.getText(sourceFile));
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

function typescriptSnippets(source: string): string[] {
	const fenced = [
		...source.matchAll(
			/^[ \t]*(?:\*\s*)?```(?:ts|typescript)\s*\r?\n([\s\S]*?)^[ \t]*(?:\*\s*)?```/gim,
		),
	].map((match) => (match[1] ?? "").replace(/^[ \t]*\* ?/gm, ""));
	if (source.trimStart().startsWith("#")) return fenced;
	return [source, ...fenced];
}

function isCommandOrQueryType(
	type: ts.TypeNode,
	sourceFile: ts.SourceFile,
): boolean {
	return /(?:Command|Query)\b/.test(type.getText(sourceFile));
}

function containsBoundaryParser(node: ts.Node): boolean {
	let found = false;
	const visit = (candidate: ts.Node): void => {
		if (isBoundaryParserCall(candidate)) {
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
		(ts.isIdentifier(owner) && owner.text === "request" && method === "json")
	);
}
