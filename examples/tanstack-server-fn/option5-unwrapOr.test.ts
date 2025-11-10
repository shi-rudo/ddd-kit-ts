import { describe, expect, it } from "vitest";
import { Outcome } from "../../src/core/result/outcome";
import type { Query } from "../../src/app/query";
import { QueryBus } from "../../src/app/query-bus";

/**
 * Option 5: Using unwrapOr() - Default Value Fallback
 * 
 * This test demonstrates using default values when queries fail
 */
describe("Option 5: Using unwrapOr()", () => {
	type GetJobOccupationQuery = Query & {
		type: "GetJobOccupation";
		jobId: string;
	};

	type JobOccupation = {
		id: string;
		title: string;
		description: string;
	};

	it("should return value when query succeeds", async () => {
		const bus = new QueryBus();
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

		const defaultJob: JobOccupation = {
			id: "default",
			title: "Unknown",
			description: "",
		};

		const job = Outcome.from(result).unwrapOr(defaultJob);

		expect(job).toEqual(mockJob);
		expect(job.id).toBe("job-123");
		expect(job.title).toBe("Software Engineer");
	});

	it("should return default value when query fails", async () => {
		const bus = new QueryBus();
		// No handler registered

		const result = await bus.execute({
			type: "GetJobOccupation",
			jobId: "job-123",
		});

		const defaultJob: JobOccupation = {
			id: "default",
			title: "Unknown",
			description: "",
		};

		const job = Outcome.from(result).unwrapOr(defaultJob);

		expect(job).toEqual(defaultJob);
		expect(job.id).toBe("default");
		expect(job.title).toBe("Unknown");
	});

	it("should work with null as default", async () => {
		const bus = new QueryBus();
		// No handler registered

		const result = await bus.execute({
			type: "GetJobOccupation",
			jobId: "job-123",
		});

		const job = Outcome.from(result).unwrapOr(null);

		expect(job).toBeNull();
	});

	it("should work with undefined as default", async () => {
		const bus = new QueryBus();
		// No handler registered

		const result = await bus.execute({
			type: "GetJobOccupation",
			jobId: "job-123",
		});

		const job = Outcome.from(result).unwrapOr(undefined);

		expect(job).toBeUndefined();
	});

	it("should work with method chaining", async () => {
		const bus = new QueryBus();
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

		const defaultJob: JobOccupation = {
			id: "default",
			title: "Unknown",
			description: "",
		};

		const transformed = Outcome.from(result)
			.map((job) => ({ ...job, processed: true }))
			.unwrapOr(defaultJob);

		expect(transformed.processed).toBe(true);
		expect(transformed.id).toBe("job-123");
	});

	it("should return default when chained operation fails", async () => {
		const bus = new QueryBus();
		// No handler registered

		const result = await bus.execute({
			type: "GetJobOccupation",
			jobId: "job-123",
		});

		const defaultJob: JobOccupation = {
			id: "default",
			title: "Unknown",
			description: "",
		};

		const transformed = Outcome.from(result)
			.map((job) => ({ ...job, processed: true }))
			.unwrapOr(defaultJob);

		expect(transformed).toEqual(defaultJob);
		expect(transformed.id).toBe("default");
	});
});

