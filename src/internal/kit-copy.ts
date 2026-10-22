import { duplicateKitCopyError } from "../errors/kit-errors";

/**
 * Each loaded copy of the kit keeps its capabilities in module-private maps,
 * so an object that another copy built never works in this one. The marker
 * lets the kit tell such an object apart from a hand-built one and fail with
 * an error that names the cause. The key is shared across copies on
 * purpose; its value is unique per copy.
 */
const KIT_COPY_KEY = Symbol.for("@shirudo/ddd-kit/kit-copy");
const THIS_COPY: object = Object.freeze({});

/** Marks `target` as built by this copy of the kit. Call it before a freeze. */
export function markKitCopy(target: object): void {
	Object.defineProperty(target, KIT_COPY_KEY, {
		value: THIS_COPY,
		enumerable: false,
		writable: false,
		configurable: false,
	});
}

/**
 * Throws `DUPLICATE_KIT_COPY` when another loaded copy of the kit
 * built `value`. The kit calls it where a lookup of its own capability
 * failed, before it reports the value as hand-built.
 */
export function assertNotFromAnotherKitCopy(
	value: unknown,
	subject: string,
): void {
	if (
		value === null ||
		(typeof value !== "object" && typeof value !== "function")
	) {
		return;
	}
	const marker = Object.getOwnPropertyDescriptor(value, KIT_COPY_KEY)?.value;
	if (marker !== undefined && marker !== THIS_COPY) {
		throw duplicateKitCopyError(subject);
	}
}
