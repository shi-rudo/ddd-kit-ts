import { err, type Result } from "@shirudo/result";
import {
	DuplicateHandlerRegistrationError,
	ErrorMapperFailedError,
	UnregisteredHandlerError,
} from "../core/errors";

/**
 * INTERNAL shared pieces of `CommandBus` and `QueryBus`. The two buses are
 * deliberately separate public classes (distinct docs, distinct handler
 * types), but their wiring semantics must not drift: the expected-error
 * decision shape, register-once guard, no-handler gate, and handler-failure
 * classification live here exactly once. Not exported from any package entry.
 */

/**
 * A positive classification decision from a bus's expected-error mapper.
 * The wrapper makes `undefined` a valid error-channel value without making
 * it ambiguous with the mapper declining to classify a thrown value.
 */
export interface ExpectedErrorDecision<E> {
	readonly error: E;
}

/**
 * Classifies and maps one handler throw. Returning `undefined` declines the
 * failure, which makes the bus rethrow the exact original value.
 */
export type ExpectedErrorMapper<E> = (
	thrown: unknown,
) => ExpectedErrorDecision<E> | undefined;

/**
 * Registers a handler exactly once. Silent replacement would turn the first
 * handler into dead code with no signal; wiring bugs must surface at
 * registration time.
 */
export function registerOnce<THandler>(
	handlers: Map<string, THandler>,
	busKind: "command" | "query",
	type: string,
	handler: THandler,
): void {
	if (handlers.has(type)) {
		throw new DuplicateHandlerRegistrationError({
			busKind,
			messageType: type,
		});
	}
	handlers.set(type, handler);
}

/**
 * Shared no-handler gate for dispatch: a wiring bug throws
 * `UnregisteredHandlerError` (crash-loud, same posture as
 * `MissingHandlerError`), it never rides the error channel. One
 * implementation so the buses and their unsafe paths cannot drift.
 */
export function handlerOrThrow<THandler>(
	handlers: Map<string, THandler>,
	busKind: "command" | "query",
	type: string,
): THandler {
	const handler = handlers.get(type);
	if (!handler) {
		throw new UnregisteredHandlerError({ busKind, messageType: type });
	}
	return handler;
}

/**
 * Classifies one registered handler failure. Absence of a mapper or an
 * `undefined` decision preserves and rethrows the exact failure: unknown
 * programmer, cancellation, and infrastructure errors cannot silently ride
 * a Result channel. A nested dispatch's wiring error always bypasses the
 * policy. A mapper that throws or returns a malformed decision is itself a
 * wiring bug and is wrapped without losing either cause.
 */
export function mapHandlerFailure<E>(
	error: unknown,
	mapExpectedError: ExpectedErrorMapper<E> | undefined,
	busKind: "command" | "query",
): Result<never, E> {
	if (
		error instanceof UnregisteredHandlerError ||
		error instanceof ErrorMapperFailedError
	) {
		throw error;
	}
	if (!mapExpectedError) throw error;

	let decision: ExpectedErrorDecision<E> | undefined;
	try {
		decision = mapExpectedError(error);
	} catch (mapperError) {
		throw new ErrorMapperFailedError({
			busKind,
			handlerError: error,
			mapperError,
		});
	}
	if (decision === undefined) throw error;

	let mapped: E;
	try {
		const candidate: unknown = decision;
		if (
			typeof candidate !== "object" ||
			candidate === null ||
			!Object.hasOwn(candidate, "error")
		) {
			throw new TypeError(
				"mapExpectedError must return undefined or an own { error } decision",
			);
		}
		mapped = (candidate as ExpectedErrorDecision<E>).error;
	} catch (mapperError) {
		throw new ErrorMapperFailedError({
			busKind,
			handlerError: error,
			mapperError,
		});
	}
	return err(mapped);
}
