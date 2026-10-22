import type { PublishChain } from "./ports";

/**
 * One dispatch on a publish chain: the event type that dispatches, and the
 * dispatch that its publication runs inside.
 *
 * Depth is the number of dispatches on the chain that are STILL OPEN, never a
 * number copied from the parent. A cycle keeps its ancestors open, because
 * each one awaits the next, so the count grows. A relay lets them finish: a
 * handler that starts the next publication without awaiting it ends, its
 * dispatch closes, and the count stays flat. A copied depth counts both the
 * same way and stops a correct relay at the bound.
 */
export class PublishChainLink {
	private open = true;

	constructor(
		readonly eventType: string,
		private parent: PublishChainLink | undefined,
	) {}

	/**
	 * Ends the dispatch. The link to the parent ends with it: a relay keeps
	 * each generation reachable, so a kept link grows the chain by one
	 * ancestor per hop.
	 */
	close(): void {
		this.open = false;
		this.parent = undefined;
	}

	/**
	 * The open dispatches from this one upward, nearest first, at most
	 * `limit`. A closed dispatch has no parent, so the walk ends there.
	 */
	openAncestry(limit: number): PublishChainLink[] {
		const ancestry: PublishChainLink[] = [];
		let current: PublishChainLink | undefined = this;
		while (current?.open && ancestry.length < limit) {
			ancestry.push(current);
			current = current.parent;
		}
		return ancestry;
	}
}

/** The link behind the opaque chain that a handler passes on. */
export function publishChainLinkOf(
	chain: PublishChain | undefined,
): PublishChainLink | undefined {
	return chain as PublishChainLink | undefined;
}

/** The opaque chain that a handler receives for one dispatch. */
export function asPublishChain(link: PublishChainLink): PublishChain {
	return link as unknown as PublishChain;
}
