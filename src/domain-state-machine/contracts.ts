/** Base shape for every input accepted by a domain state machine. */
export type DomainMachineInput = {
	readonly type: string;
};

/** Recursively readonly view of data accepted by the domain state machine. */
export type DomainMachineReadonly<TValue> = TValue extends
	| bigint
	| boolean
	| null
	| number
	| string
	| symbol
	| undefined
	? TValue
	: TValue extends (...args: never[]) => unknown
		? TValue
		: TValue extends readonly unknown[]
			? {
					readonly [TKey in keyof TValue]: DomainMachineReadonly<TValue[TKey]>;
				}
			: TValue extends object
				? {
						readonly [TKey in keyof TValue]: DomainMachineReadonly<
							TValue[TKey]
						>;
					}
				: TValue;

/** Immutable state and context value suitable for persistence. */
export type DomainMachineSnapshot<TState extends string, TContext> = {
	readonly state: TState;
	readonly context: DomainMachineReadonly<TContext>;
};

/** Optional context replacement and requested external work from a reducer. */
export type DomainTransitionResult<TContext, TOutput> = {
	readonly context?: TContext;
	readonly outputs?: readonly TOutput[];
};

/** A guarded state change and its optional pure context reducer. */
export type DomainTransition<
	TState extends string,
	TContext,
	TInput extends DomainMachineInput,
	TOutput,
> = {
	readonly target: TState;
	/** Must be synchronous, deterministic, and side-effect-free. */
	readonly guard?: (input: {
		readonly state: TState;
		readonly context: DomainMachineReadonly<TContext>;
		readonly input: DomainMachineReadonly<TInput>;
	}) => boolean;
	/** Must be synchronous, deterministic, and side-effect-free. */
	readonly reduce?: (input: {
		readonly state: TState;
		readonly context: DomainMachineReadonly<TContext>;
		readonly input: DomainMachineReadonly<TInput>;
	}) => DomainTransitionResult<TContext, TOutput> | undefined;
};

/** Configuration for one named control state. */
export type DomainStateNode<
	TState extends string,
	TContext,
	TInput extends DomainMachineInput,
	TOutput,
> = {
	readonly terminal?: boolean;
	readonly on?: {
		readonly [TType in TInput["type"]]?: DomainTransition<
			TState,
			TContext,
			Extract<TInput, { readonly type: TType }>,
			TOutput
		>;
	};
};

/** Complete, finite domain lifecycle definition. */
export type DomainMachineDefinition<
	TState extends string,
	TContext,
	TInput extends DomainMachineInput,
	TOutput = never,
> = {
	readonly initial: TState;
	readonly initialContext: () => TContext;
	/** Must be synchronous, deterministic, and side-effect-free. */
	readonly validateSnapshot?: (
		snapshot: DomainMachineSnapshot<TState, TContext>,
	) => boolean;
	readonly states: {
		readonly [TName in TState]: DomainStateNode<
			TState,
			TContext,
			TInput,
			TOutput
		>;
	};
};

/** Result of a successful transition. */
export type DomainTransitionOutcome<
	TState extends string,
	TContext,
	TOutput,
> = {
	readonly from: TState;
	readonly to: TState;
	readonly snapshot: DomainMachineSnapshot<TState, TContext>;
	readonly outputs: readonly DomainMachineReadonly<TOutput>[];
};
