/**
 * The Standard Schema interface, version 1 (https://standardschema.dev).
 * zod, valibot, arktype, and other schema libraries implement it. The spec
 * invites a library that accepts schemas to copy these types instead of
 * depending on `@standard-schema/spec`, so the kit adds no dependency. The
 * types follow `@standard-schema/spec` 1.1.0 (MIT License).
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
	/** The Standard Schema properties. */
	readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

// The namespace mirrors the spec, so a schema type of any library that
// implements it is assignable to this one.
export declare namespace StandardSchemaV1 {
	/** The Standard Schema properties interface. */
	interface Props<Input = unknown, Output = Input> {
		/** The version number of the standard. */
		readonly version: 1;
		/** The vendor name of the schema library. */
		readonly vendor: string;
		/** Validates unknown input values. */
		readonly validate: (
			value: unknown,
			options?: Options | undefined,
		) => Result<Output> | Promise<Result<Output>>;
		/** Inferred types associated with the schema. */
		readonly types?: Types<Input, Output> | undefined;
	}

	/** The result interface of the validate function. */
	type Result<Output> = SuccessResult<Output> | FailureResult;

	/** The result interface if validation succeeds. */
	interface SuccessResult<Output> {
		/** The typed output value. */
		readonly value: Output;
		/** A falsy value for `issues` indicates success. */
		readonly issues?: undefined;
	}

	/** The options of the validate function. */
	interface Options {
		/** Explicit support for additional vendor-specific parameters. */
		readonly libraryOptions?: Record<string, unknown> | undefined;
	}

	/** The result interface if validation fails. */
	interface FailureResult {
		/** The issues of failed validation. */
		readonly issues: ReadonlyArray<Issue>;
	}

	/** The issue interface of the failure output. */
	interface Issue {
		/** The error message of the issue. */
		readonly message: string;
		/** The path of the issue, if any. */
		readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
	}

	/** The path segment interface of the issue. */
	interface PathSegment {
		/** The key representing a path segment. */
		readonly key: PropertyKey;
	}

	/** The Standard Schema types interface. */
	interface Types<Input = unknown, Output = Input> {
		/** The input type of the schema. */
		readonly input: Input;
		/** The output type of the schema. */
		readonly output: Output;
	}

	/** Infers the input type of a Standard Schema. */
	type InferInput<Schema extends StandardSchemaV1> = NonNullable<
		Schema["~standard"]["types"]
	>["input"];

	/** Infers the output type of a Standard Schema. */
	type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
		Schema["~standard"]["types"]
	>["output"];
}
