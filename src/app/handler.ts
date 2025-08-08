import type { Result } from "../core/result";
import type { EventBus, Outbox } from "../events/ports";
import type { UnitOfWork } from "../repo/uow";

export type CommandHandler<C, R> = (cmd: C) => Promise<Result<R, string>>;
export function withCommit<Evt, R>(
	deps: {
		outbox: Outbox<Evt>;
		bus?: EventBus<Evt>;
		uow: UnitOfWork;
	},
	fn: () => Promise<{ result: R; events: ReadonlyArray<Evt> }>,
) {
	return deps.uow.transactional(async () => {
		const { result, events } = await fn();
		await deps.outbox.add(events);
		if (deps.bus) await deps.bus.publish(events);
		return result;
	});
}
