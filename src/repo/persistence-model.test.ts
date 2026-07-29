import { describe, expect, it } from "vite-plus/test";
import {
	capturePersistenceBaseline,
	derivePersistenceChanges,
	insertPersistenceBaseline,
	type PersistenceModel,
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
});
