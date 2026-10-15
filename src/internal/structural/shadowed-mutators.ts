/**
 * `Object.freeze` does not protect internal slots: a frozen Date still
 * accepts `setTime`, a frozen Map still accepts `set`. A deep freeze
 * therefore shadows these mutator methods with own, non-enumerable,
 * throwing functions. `structuredClone` drops the shadows, and a walk
 * that checks a copy accepts them as machinery, not data.
 */
export const DATE_MUTATORS: readonly string[] = [
	"setTime",
	"setMilliseconds",
	"setUTCMilliseconds",
	"setSeconds",
	"setUTCSeconds",
	"setMinutes",
	"setUTCMinutes",
	"setHours",
	"setUTCHours",
	"setDate",
	"setUTCDate",
	"setMonth",
	"setUTCMonth",
	"setFullYear",
	"setUTCFullYear",
	"setYear",
];
export const MAP_MUTATORS: readonly string[] = ["set", "delete", "clear"];
export const SET_MUTATORS: readonly string[] = ["add", "delete", "clear"];

const mutatorsByTag: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["[object Date]", new Set(DATE_MUTATORS)],
	["[object Map]", new Set(MAP_MUTATORS)],
	["[object Set]", new Set(SET_MUTATORS)],
]);

/**
 * Whether `key` names a mutator that a deep freeze shadows on the
 * built-in with the tag `tag`.
 */
export function isShadowedMutator(tag: string, key: string): boolean {
	return mutatorsByTag.get(tag)?.has(key) ?? false;
}
