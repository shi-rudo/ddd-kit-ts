import { describe, expect, it, vi } from "vite-plus/test";
import {
	createDomainEvent,
	createDomainEventFactory,
	type DomainEvent,
	defineDomainEvent,
	defineRepository,
	type Id,
	type StandardSchemaV1,
	StateStoredAggregate,
	ValueObject,
} from "../../src/index";
import { recordingOutbox } from "../../src/testing/recording-outbox";

// A duplicate npm dependency or an adapter package that bundles the kit
// loads a second copy of it. vi.resetModules() followed by a dynamic import
// evaluates the kit again, like such a second copy. Each copy keeps its
// capabilities to itself, so an object of the other copy must fail loud
// with the code that names the cause, not as a hand-built object.

type NoteId = Id<"NoteId">;
type NoteWritten = DomainEvent<"NoteWritten", { text: string }>;

class Note extends StateStoredAggregate<{ text: string }, NoteId, NoteWritten> {
	protected readonly aggregateType = "Note";

	constructor(id: NoteId) {
		super(id, { text: "" });
	}

	write(text: string): void {
		this.setState({ text }, this.createEvent("NoteWritten", { text }));
	}
}

class Amount extends ValueObject<{ minor: number }> {}

const anySchema: StandardSchemaV1 = {
	"~standard": {
		version: 1,
		vendor: "test",
		validate: (value) => ({ value }),
	},
};

async function secondKitCopy(): Promise<typeof import("../../src/index")> {
	vi.resetModules();
	return import("../../src/index");
}

function thrownBy(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to throw");
}

describe("a second loaded copy of the kit", () => {
	it("rejects an aggregate of the first copy", async () => {
		const note = new Note("note-1" as NoteId);
		note.write("hello");
		const second = await secondKitCopy();

		const error = thrownBy(() =>
			second.stampPendingEvents(note, second.createDomainEventFactory()),
		);

		expect(error).toMatchObject({ code: "DUPLICATE_KIT_COPY" });
	});

	it("rejects an event of the first copy in a recording path", async () => {
		const event = createDomainEvent("NoteWritten", { text: "hello" });
		const second = await secondKitCopy();
		class SecondCopyNote extends second.StateStoredAggregate<
			{ text: string },
			NoteId,
			NoteWritten
		> {
			protected readonly aggregateType = "Note";

			constructor(id: NoteId) {
				super(id, { text: "" });
			}

			record(foreign: NoteWritten): void {
				this.setState({ text: "hello" }, foreign);
			}
		}
		const note = new SecondCopyNote("note-1" as NoteId);

		expect(thrownBy(() => note.record(event))).toMatchObject({
			code: "DUPLICATE_KIT_COPY",
		});
	});

	it("rejects an event definition of the first copy", async () => {
		const definition = defineDomainEvent("NoteWritten", { payload: anySchema });
		const second = await secondKitCopy();

		const error = thrownBy(() =>
			second.createDomainEvent(definition as never, { text: "hello" }),
		);

		expect(error).toMatchObject({ code: "DUPLICATE_KIT_COPY" });
	});

	it("rejects a value object of the first copy nested in a value object", async () => {
		const amount = new Amount({ minor: 100 });
		const second = await secondKitCopy();

		const error = thrownBy(() => second.valueObject({ amount }));

		expect(error).toMatchObject({ code: "DUPLICATE_KIT_COPY" });
	});

	it("rejects a repository definition of the first copy", async () => {
		const definition = defineRepository<{
			add(note: Note): void;
			update(note: Note): void;
		}>()({
			aggregate: Note,
			persistence: {
				capture: (note: Note) => note.version,
				changes: (_baseline: number | undefined, note: Note) => note.version,
				isEmpty: () => false,
			},
			create: () => ({}),
			flush: async () => {},
			mapError: (error: unknown) => {
				throw error;
			},
		});
		const second = await secondKitCopy();
		const uow = new second.UnitOfWork({
			scope: { transactional: (work) => work(undefined) },
			outbox: recordingOutbox(),
			repositories: { notes: definition } as never,
		});

		const error = await uow.run(async () => undefined).catch((e) => e);

		expect(error).toMatchObject({ code: "DUPLICATE_KIT_COPY" });
	});

	it("still reports a hand-built object as hand-built", async () => {
		const second = await secondKitCopy();

		const error = thrownBy(() =>
			second.stampPendingEvents(
				{ id: "note-1", version: 0, pendingEvents: [] } as never,
				createDomainEventFactory(),
			),
		);

		expect(error).toMatchObject({ code: "UNMANAGED_INSTANCE" });
	});
});
