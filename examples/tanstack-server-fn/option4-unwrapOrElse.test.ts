import { describe, expect, it } from "vitest";
import { Outcome } from "../../src/core/result/outcome";
import type { Query } from "../../src/app/query";
import { QueryBus } from "../../src/app/query-bus";

/**
 * Option 4: Using unwrapOrElse() - Custom Error Transformation
 * 
 * This test demonstrates custom error transformation
 */
describe("Option 4: Using unwrapOrElse()", () => {
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

		const job = Outcome.from(result).unwrapOrElse((error) => {
			throw new Error(`Query failed: ${error}`);
		});

		expect(job).toEqual(mockJob);
		expect(job.id).toBe("job-123");
	});

	it("should transform error to custom exception", async () => {
		const bus = new QueryBus();
		// No handler registered

		const result = await bus.execute({
			type: "GetJobOccupation",
			jobId: "job-123",
		});

		expect(() =>
			Outcome.from(result).unwrapOrElse((error) => {
				throw new Error(`Query failed: ${error}`);
			}),
		).toThrow(/Query failed:/);
	});

	it("should allow custom error messages", async () => {
		const bus = new QueryBus();
		// No handler registered

		const result = await bus.execute({
			type: "GetJobOccupation",
			jobId: "job-123",
		});

		expect(() =>
			Outcome.from(result).unwrapOrElse((error) => {
				throw new Error(`Failed to fetch job occupation: ${error}`);
			}),
		).toThrow(/Failed to fetch job occupation:/);
	});

	it("should allow returning default value instead of throwing", async () => {
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

		const job = Outcome.from(result).unwrapOrElse(() => defaultJob);

		expect(job).toEqual(defaultJob);
		expect(job.id).toBe("default");
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

		const transformed = Outcome.from(result)
			.map((job) => ({ ...job, processed: true }))
			.unwrapOrElse((error) => {
				throw new Error(`Failed: ${error}`);
			});

		expect(transformed.processed).toBe(true);
		expect(transformed.id).toBe("job-123");
	});
});

