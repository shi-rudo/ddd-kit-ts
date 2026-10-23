import type { KitWiringError } from "../../errors/kit-errors";
import { copyPlainData } from "../../internal/structural/plain-data";
import { deepFreeze } from "../value-object/value-object";
import type { DomainMachineInput, DomainMachineReadonly } from "./contracts";
import {
	invalidDomainMachineContextError,
	invalidDomainMachineInputError,
	invalidDomainTransitionResultError,
} from "./errors";

type DomainMachineDataErrorFactory = (
	message: string,
	cause: unknown,
) =>
	| KitWiringError<"INVALID_DOMAIN_MACHINE_CONTEXT">
	| KitWiringError<"INVALID_DOMAIN_MACHINE_INPUT">
	| KitWiringError<"INVALID_DOMAIN_TRANSITION_RESULT">;

export function copyDomainMachineOutputs<TOutput>(
	outputs: readonly (TOutput | DomainMachineReadonly<TOutput>)[] | undefined,
): readonly DomainMachineReadonly<TOutput>[] {
	return freezeDomainMachineData(
		outputs ?? [],
		"Domain transition result outputs",
		(message, cause) => invalidDomainTransitionResultError(message, cause),
	) as readonly DomainMachineReadonly<TOutput>[];
}

export function copyDomainMachineInput<TInput extends DomainMachineInput>(
	input: TInput,
): DomainMachineReadonly<TInput> {
	return freezeDomainMachineData(
		input,
		"Domain machine input",
		(message, cause) => invalidDomainMachineInputError(message, cause),
	) as DomainMachineReadonly<TInput>;
}

export function copyDomainMachineContext<TContext>(
	context: TContext | DomainMachineReadonly<TContext>,
): DomainMachineReadonly<TContext> {
	return freezeDomainMachineData(
		context,
		"Domain machine context",
		(message, cause) => invalidDomainMachineContextError(message, cause),
	) as DomainMachineReadonly<TContext>;
}

/**
 * Copies machine data under the plain-data rule of the kit and freezes the
 * copy. A value outside the rule throws the error of the caller, with the
 * message of the copy and the copy's error as the cause.
 */
function freezeDomainMachineData<TValue>(
	value: TValue,
	subject: string,
	error: DomainMachineDataErrorFactory,
): TValue {
	let copy: TValue;
	try {
		copy = copyPlainData(value, { subject });
	} catch (cause) {
		throw error(cause instanceof Error ? cause.message : String(cause), cause);
	}
	return deepFreeze(copy) as TValue;
}

export function isRecord(
	value: unknown,
): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A record whose prototype is `null` or an `Object.prototype` of any realm. */
export function isPlainRecord(
	value: unknown,
): value is Record<PropertyKey, unknown> {
	if (!isRecord(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || Object.getPrototypeOf(prototype) === null;
}

export function hasOwn<T extends object>(
	value: T,
	key: PropertyKey,
): key is keyof T {
	return Object.hasOwn(value, key);
}
