export type DomainMachineEvent = {
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

export type DomainMachineSnapshot<TState extends string, TContext> = {
	readonly state: TState;
	readonly context: DomainMachineReadonly<TContext>;
};

export type DomainTransitionResult<TContext, TOutput> = {
	readonly context?: TContext;
	readonly outputs?: readonly TOutput[];
};

export type DomainTransition<
	TState extends string,
	TContext,
	TEvent extends DomainMachineEvent,
	TOutput,
> = {
	readonly target: TState;
	/** Must be synchronous, deterministic, and side-effect-free. */
	readonly guard?: (input: {
		readonly state: TState;
		readonly context: DomainMachineReadonly<TContext>;
		readonly event: DomainMachineReadonly<TEvent>;
	}) => boolean;
	/** Must be synchronous, deterministic, and side-effect-free. */
	readonly reduce?: (input: {
		readonly state: TState;
		readonly context: DomainMachineReadonly<TContext>;
		readonly event: DomainMachineReadonly<TEvent>;
	}) => DomainTransitionResult<TContext, TOutput> | undefined;
};

export type DomainStateNode<
	TState extends string,
	TContext,
	TEvent extends DomainMachineEvent,
	TOutput,
> = {
	readonly terminal?: boolean;
	readonly on?: {
		readonly [TType in TEvent["type"]]?: DomainTransition<
			TState,
			TContext,
			Extract<TEvent, { readonly type: TType }>,
			TOutput
		>;
	};
};

export type DomainMachineDefinition<
	TState extends string,
	TContext,
	TEvent extends DomainMachineEvent,
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
			TEvent,
			TOutput
		>;
	};
};

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
