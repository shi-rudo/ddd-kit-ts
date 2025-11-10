import { describe, expect, it } from "vitest";
import type { Query } from "../../src/app/query";
import { QueryBus } from "../../src/app/query-bus";
import { Outcome } from "../../src/core/result/outcome";

/**
 * Option 1: Using unwrap() - Throws Exception on Error
 * 
 * This test demonstrates the simplest approach using Outcome.unwrap()
 */
describe("Option 1: Using unwrap()", () => {
	type GetJobOccupationQuery = Query & {
		type: "GetJobOccupation";
		jobId: string;
	};

	type JobOccupation = {
		id: string;
		title: string;
		description: string;
	};

	type QueryMap = {
		GetJobOccupation: JobOccupation;
	};

	it("should return value when query succeeds", async () => {
		const bus = new QueryBus<QueryMap>();
		const mockJob: JobOccupation = {
			id: "job-123",
			title: "Software Engineer",
			description: "Build amazing software",
		};

		bus.register("GetJobOccupation", async (query: GetJobOccupationQuery) => {
			return mockJob;
		});

		const result = await bus.execute({
			type: "GetJobOccupation",
			jobId: "job-123",
		});

		const outcome = Outcome.from(result);
		const job = outcome.unwrap();

		expect(job).toEqual(mockJob);
		expect(job.id).toBe("job-123");
		expect(job.title).toBe("Software Engineer");
	});

	it("should throw exception when query fails", async () => {
		const bus = new QueryBus<QueryMap>();
		// No handler registered, so execute will return an error

		const result = await bus.execute({
			type: "GetJobOccupation",
			jobId: "job-123",
		});

		const outcome = Outcome.from(result);

		expect(() => outcome.unwrap()).toThrow();
		expect(() => outcome.unwrap()).toThrow(/No handler registered/);
	});

	it("should throw custom error when handler throws", async () => {
		const bus = new QueryBus<QueryMap>();
		const customError = new Error("Database connection failed");

		bus.register("GetJobOccupation", async () => {
			throw customError;
		});

		const result = await bus.execute({
			type: "GetJobOccupation",
			jobId: "job-123",
		});

		const outcome = Outcome.from(result);

		expect(() => outcome.unwrap()).toThrow("Database connection failed");
	});

	it("should work with method chaining", async () => {
		const bus = new QueryBus<QueryMap>();
		const mockJob: JobOccupation = {
			id: "job-123",
			title: "Software Engineer",
			description: "Build amazing software",
		};

		bus.register("GetJobOccupation", async () => mockJob);

		const result = await bus.execute({
			type: "GetJobOccupation",
			jobId: "job-123",
		});

		const transformed = Outcome.from(result)
			.map((job) => ({ ...job, processed: true }))
			.unwrap();

		expect(transformed.processed).toBe(true);
		expect(transformed.id).toBe("job-123");
	});
});

