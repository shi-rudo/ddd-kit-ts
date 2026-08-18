import { describe, expect, it } from "vite-plus/test";
import {
	capturePersistenceBaseline,
	derivePersistenceChanges,
	insertPersistenceBaseline,
	type PersistenceModel,
	persistenceProjectionDrifted,
	recapturePersistenceBaseline,
} from "./persistence-model";

describe("adapter-owned persistence baselines", () => {
	it("derives changes for a primitive persistence projection", () => {
		type Counter = { value: number };
		const model: PersistenceModel<Counter, number, number | undefined> = {
			capture: (counter) => counter.value,
			changes: (baseline, counter) =>
				baseline === counter.value ? undefined : counter.value,
			isEmpty: (change) => change === undefined,
		};
		const counter = { value: 1 };
		const baseline = capturePersistenceBaseline(model, counter);

		counter.value = 2;

		expect(derivePersistenceChanges(baseline, counter)).toEqual({
			value: 2,
			empty: false,
		});
	});

	it("lets an adapter derive a collection-aware partial change set", () => {
		type Basket = { lines: Array<{ sku: string; quantity: number }> };
		type Baseline = ReadonlyMap<string, number>;
		type Changes = ReadonlyArray<
			| { kind: "upsert"; sku: string; quantity: number }
			| { kind: "remove"; sku: string }
		>;
		const model: PersistenceModel<Basket, Baseline, Changes> = {
			capture: (basket) =>
				new Map(basket.lines.map((line) => [line.sku, line.quantity])),
			changes: (baseline, basket) => {
				const before = baseline ?? new Map<string, number>();
				const after = new Map(
					basket.lines.map((line) => [line.sku, line.quantity]),
				);
				const changes: Array<Changes[number]> = [];
				for (const [sku, quantity] of after) {
					if (before.get(sku) !== quantity) {
						changes.push({ kind: "upsert", sku, quantity });
					}
				}
				for (const sku of before.keys()) {
					if (!after.has(sku)) changes.push({ kind: "remove", sku });
				}
				return changes;
			},
			isEmpty: (changes) => changes.length === 0,
		};
		const basket: Basket = {
			lines: [
				{ sku: "A", quantity: 1 },
				{ sku: "B", quantity: 1 },
			],
		};
		const baseline = capturePersistenceBaseline(model, basket);

		basket.lines = [
			{ sku: "A", quantity: 2 },
			{ sku: "C", quantity: 1 },
		];

		expect(derivePersistenceChanges(baseline, basket).value).toEqual([
			{ kind: "upsert", sku: "A", quantity: 2 },
			{ kind: "upsert", sku: "C", quantity: 1 },
			{ kind: "remove", sku: "B" },
		]);
	});

	it("supports full replacement instead of imposing a partial-diff model", () => {
		type Profile = { name: string; tags: string[] };
		type Projection = Readonly<{ name: string; tags: readonly string[] }>;
		const project = (profile: Profile): Projection => ({
			name: profile.name,
			tags: [...profile.tags],
		});
		const model: PersistenceModel<Profile, Projection, Projection | undefined> =
			{
				capture: project,
				changes: (baseline, profile) => {
					const current = project(profile);
					return JSON.stringify(baseline) === JSON.stringify(current)
						? undefined
						: current;
				},
				isEmpty: (replacement) => replacement === undefined,
			};
		const profile = { name: "Ada", tags: ["admin"] };
		const baseline = capturePersistenceBaseline(model, profile);

		profile.tags = ["admin", "author"];

		expect(derivePersistenceChanges(baseline, profile)).toEqual({
			value: { name: "Ada", tags: ["admin", "author"] },
			empty: false,
		});
	});

	it("represents inserts explicitly and can seal the current projection", () => {
		type RecordState = { value: string };
		const model: PersistenceModel<RecordState, string, string | undefined> = {
			capture: (state) => state.value,
			changes: (baseline, state) =>
				baseline === state.value ? undefined : state.value,
			isEmpty: (change) => change === undefined,
		};
		const state = { value: "first" };
		const insert = insertPersistenceBaseline(model);

		expect(derivePersistenceChanges(insert, state)).toEqual({
			value: "first",
			empty: false,
		});

		const sealed = recapturePersistenceBaseline(insert, state);
		expect(derivePersistenceChanges(sealed, state)).toEqual({
			value: undefined,
			empty: true,
		});
	});

	it("keeps the adapter baseline opaque", () => {
		const model: PersistenceModel<{ value: number }, number, number> = {
			capture: (state) => state.value,
			changes: (_baseline, state) => state.value,
			isEmpty: () => false,
		};
		const baseline = capturePersistenceBaseline(model, { value: 1 });

		// @ts-expect-error the Unit of Work and domain cannot inspect adapter data
		void baseline.value;
		// @ts-expect-error model internals are capability-backed, not public fields
		void baseline.model;

		expect(Object.keys(baseline)).toEqual([]);
	});

	it("detects projection drift structurally, not through the change set", () => {
		const model: PersistenceModel<
			{ value: number },
			{ value: number },
			{ value: number }
		> = {
			capture: (state) => ({ value: state.value }),
			// Full replacement: the change set is the whole row and never empty.
			changes: (_baseline, state) => ({ value: state.value }),
			isEmpty: () => false,
		};
		const state = { value: 1 };
		const baseline = capturePersistenceBaseline(model, state);

		expect(persistenceProjectionDrifted(baseline, state)).toBe(false);
		expect(persistenceProjectionDrifted(baseline, { value: 2 })).toBe(true);
		// A "new" baseline has no stored capture to drift from.
		expect(
			persistenceProjectionDrifted(insertPersistenceBaseline(model), state),
		).toBe(false);
	});

	it("lets a model whose capture re-materializes Set members supply captureEquals", () => {
		interface Line {
			readonly sku: string;
		}
		interface Cart {
			readonly skus: ReadonlyArray<string>;
		}
		// Rebuilt object Set members compare by reference under the default
		// deep equality, so this capture shape needs its own comparison.
		const capture = (cart: Cart) => ({
			lines: new Set<Line>(cart.skus.map((sku) => ({ sku }))),
		});
		type Row = ReturnType<typeof capture>;
		const sameLines = (a: Row, b: Row): boolean =>
			a.lines.size === b.lines.size &&
			[...a.lines].every(({ sku }) =>
				[...b.lines].some((line) => line.sku === sku),
			);
		const withoutEquality: PersistenceModel<Cart, Row, Row> = {
			capture,
			changes: (_baseline, cart) => capture(cart),
			isEmpty: () => false,
		};
		const withEquality: PersistenceModel<Cart, Row, Row> = {
			...withoutEquality,
			captureEquals: sameLines,
		};
		const cart: Cart = { skus: ["a", "b"] };

		// The documented default trap: reference-matched Set members drift.
		expect(
			persistenceProjectionDrifted(
				capturePersistenceBaseline(withoutEquality, cart),
				cart,
			),
		).toBe(true);

		const baseline = capturePersistenceBaseline(withEquality, cart);
		expect(persistenceProjectionDrifted(baseline, cart)).toBe(false);
		expect(
			persistenceProjectionDrifted(baseline, { skus: ["a", "changed"] }),
		).toBe(true);
	});
});
