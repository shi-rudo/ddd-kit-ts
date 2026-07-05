import { err, type Result } from "@shirudo/result";
import {
	ErrorMapperFailedError,
	UnregisteredHandlerError,
} from "../core/errors";
import { describeThrown } from "./describe-thrown";

/**
 * INTERNAL shared pieces of `CommandBus` and `QueryBus`. The two buses are
 * deliberately separate public classes (distinct docs, distinct handler
 * types), but their wiring semantics must not drift: the options contract,
 * the register-once guard, the no-handler gate, and the handler-failure
 * mapping live here exactly once. Not exported from any package entry.
 */

/** The one option shape both buses share. */
export interface BusOptions<E> {
	errorMapper?: (thrown: unknown) => E;
}

/**
 * Constructor arguments for a bus with error channel `E`. Options are
 * optional only when `E` IS the default `string` (the built-in
 * {@link describeThrown} mapper applies); the unavoidable `any` also
 * passes. For every other `E` an `errorMapper` is required, so a typed
 * channel can never silently fall back to string values. Both directions
 * of the test matter: every string-literal union is a SUBTYPE of `string`
 * and would pass a bare `[E] extends [string]` (describeThrown could then
 * deliver arbitrary strings outside the declared union), while `unknown`
 * would pass a bare `[string] extends [E]` (silently flattening rich
 * thrown values to strings on a channel that says "I handle raw values").
 */
export type BusArgs<E, TOptions extends BusOptions<E>> = [E] extends [string]
	? [string] extends [E]
		? [options?: TOptions]
		: [options: TOptions & { errorMapper: (thrown: unknown) => E }]
	: [options: TOptions & { errorMapper: (thrown: unknown) => E }];

/**
 * Resolves the effective error mapper for a bus. describeThrown produces a
 * string; that is the correct mapper only for the default `E = string`.
 * {@link BusArgs} makes `errorMapper` mandatory once `E` is widened, so the
 * fallback is never reached with a non-string `E`.
 */
export function resolveErrorMapper<E>(
	options: BusOptions<E> | undefined,
): (thrown: unknown) => E {
	return options?.errorMapper ?? (describeThrown as (thrown: unknown) => E);
}

/** Display label for wiring-bug messages, per bus kind. */
function busLabel(busKind: "command" | "query"): string {
	return busKind === "command" ? "CommandBus" : "QueryBus";
}

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
		throw new Error(
			`${busLabel(busKind)}: a handler for ${busKind} type "${type}" is already registered`,
		);
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
 * Delivers a registered handler's failure through the error channel. A
 * NESTED dispatch's wiring bug (a handler awaiting `execute` for a typoed
 * type) must stay a throw: the channel carries expected failures a
 * registered handler produced, never a mis-wired bus. A THROWING mapper is
 * a wiring bug too: its throw must not replace the handler's original
 * failure, so it is wrapped in `ErrorMapperFailedError` carrying the
 * original error as `cause` and the mapper's failure as `mapperCause`.
 */
export function mapHandlerFailure<E>(
	error: unknown,
	errorMapper: (thrown: unknown) => E,
	busKind: "command" | "query",
): Result<never, E> {
	if (
		error instanceof UnregisteredHandlerError ||
		error instanceof ErrorMapperFailedError
	) {
		throw error;
	}
	let mapped: E;
	try {
		mapped = errorMapper(error);
	} catch (mapperError) {
		throw new ErrorMapperFailedError({
			busKind,
			handlerError: error,
			mapperError,
		});
	}
	return err(mapped);
}
