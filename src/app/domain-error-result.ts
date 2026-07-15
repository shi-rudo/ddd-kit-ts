import { err, ok, type Result } from "@shirudo/result";
import { DomainError } from "../core/errors";

/** A concrete consumer-defined DomainError subclass accepted at a boundary. */
export type DomainErrorClass<E extends DomainError = DomainError> = new (
	...args: never[]
) => E;

type ListedDomainError<TClasses extends readonly DomainErrorClass[]> =
	InstanceType<TClasses[number]>;

/**
 * Runs application-boundary work and turns only explicitly listed domain
 * rejections into a typed Result error. Every unlisted DomainError and every
 * non-domain failure is rethrown unchanged. The class list is copied and
 * validated before work starts.
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
	const stableExpectedErrors = [...expectedErrors];
	assertExpectedErrorClasses(stableExpectedErrors);

	try {
		return ok(await operation());
	} catch (error) {
		for (const errorClass of stableExpectedErrors) {
			if (
				((typeof error === "object" && error !== null) ||
					typeof error === "function") &&
				Object.prototype.isPrototypeOf.call(errorClass.prototype, error)
			) {
				return err(error as ListedDomainError<TClasses>);
			}
		}
		throw error;
	}
}

function assertExpectedErrorClasses(
	errorClasses: readonly unknown[],
): asserts errorClasses is readonly [DomainErrorClass, ...DomainErrorClass[]] {
	if (errorClasses.length === 0) {
		throw new TypeError(
			"domainErrorToResult requires at least one expected DomainError class",
		);
	}
	for (const errorClass of errorClasses) {
		if (
			typeof errorClass !== "function" ||
			!Object.prototype.isPrototypeOf.call(
				DomainError.prototype,
				errorClass.prototype,
			)
		) {
			throw new TypeError(
				"domainErrorToResult expected every entry to be a concrete DomainError subclass",
			);
		}
	}
}
