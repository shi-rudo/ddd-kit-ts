// Functional API - Types and functions
export type { Err, Ok, Result } from "./result";
export {
	andThen,
	andThenAsync,
	err,
	isErr,
	isOk,
	map,
	mapAsync,
	mapErr,
	mapErrAsync,
	match,
	matchAsync,
	ok,
	pipe,
	pipeAsync,
	tryCatch,
	tryCatchAsync,
	unwrapOr,
	unwrapOrElse,
} from "./result";

// Class-based API - Classes
// Note: Factory functions Ok() and Err() are available via direct import from "./outcome"
// to avoid naming conflicts with types Ok<T> and Err<E>
export { Erroneous, Outcome, Success } from "./outcome";
