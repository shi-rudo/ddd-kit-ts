import { err, ok, type Result } from "@shirudo/result";
import { DomainError } from "../errors/kit-errors";

/** A concrete consumer-defined DomainError subclass accepted at a boundary. */
export type DomainErrorClass<E extends DomainError = DomainError> = new (
	...args: never[]
) => E;

type ListedDomainError<TClasses extends readonly DomainErrorClass[]> =
	InstanceType<TClasses[number]>;

/**
 * Runs application-boundary work and turns only explicitly listed domain
 * rejections into a typed Result error. Every unlisted DomainError and every
 * non-domain failure is rethrown unchanged. The class list is validated
 * before work starts.
 *
 * @throws TypeError when expectedErrors is empty or contains a non-DomainError
 * class
 * @throws The exact operation failure when it is not an instance of a listed
 * class
 */
export async function domainErrorToResult<
	T,
	const TClasses extends readonly [DomainErrorClass, ...DomainErrorClass[]],
>(
	operation: () => T | PromiseLike<T>,
	expectedErrors: TClasses,
): Promise<Result<T, ListedDomainError<TClasses>>> {
	assertExpectedErrorClasses(expectedErrors);

	try {
		return ok(await operation());
	} catch (error) {
		if (expectedErrors.some((errorClass) => error instanceof errorClass)) {
			return err(error as ListedDomainError<TClasses>);
		}
		throw error;
	}
}

function assertExpectedErrorClasses(errorClasses: readonly unknown[]): void {
	if (errorClasses.length === 0) {
		throw new TypeError(
			"domainErrorToResult requires at least one expected DomainError class",
		);
	}
	for (const errorClass of errorClasses) {
		if (
			typeof errorClass !== "function" ||
			!(errorClass.prototype instanceof DomainError)
		) {
			throw new TypeError(
				"domainErrorToResult expected every entry to be a concrete DomainError subclass",
			);
		}
	}
}
