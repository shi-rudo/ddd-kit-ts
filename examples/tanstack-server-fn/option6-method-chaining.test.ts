import { describe, expect, it } from "vitest";
import type { Query } from "../../src/app/query";
import { QueryBus } from "../../src/app/query-bus";
import { Outcome } from "../../src/core/result/outcome";
import { err, ok } from "../../src/core/result/result";

/**
 * Option 6: Method Chaining with Transformations
 * 
 * This test demonstrates composable transformations with method chaining
 */
describe("Option 6: Method Chaining", () => {
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

	it("should chain map transformations", async () => {
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
			.map((job) => ({ ...job, processedAt: new Date() }))
			.map((job) => ({ ...job, status: "active" }))
			.unwrap();

		expect(transformed.id).toBe("job-123");
		expect(transformed.processedAt).toBeInstanceOf(Date);
		expect(transformed.status).toBe("active");
	});

	it("should chain mapErr transformations", async () => {
		const bus = new QueryBus<QueryMap>();
		// No handler registered

		const result = await bus.execute({
			type: "GetJobOccupation",
			jobId: "job-123",
		});

		// This will throw, but the error message should be transformed
		expect(() =>
			Outcome.from(result)
				.mapErr((error) => `Failed to fetch job: ${error}`)
				.mapErr((error) => `[ERROR] ${error}`)
				.unwrap(),
		).toThrow(/\[ERROR\] Failed to fetch job:/);
	});

	it("should chain andThen operations", async () => {
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
			.andThen((job) => ok({ ...job, step1: true }))
			.andThen((job) => ok({ ...job, step2: true }))
			.map((job) => ({ ...job, step3: true }))
			.unwrap();

		expect(transformed.step1).toBe(true);
		expect(transformed.step2).toBe(true);
		expect(transformed.step3).toBe(true);
		expect(transformed.id).toBe("job-123");
	});

	it("should handle errors in andThen chain", async () => {
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

		// The error should propagate through the chain
		expect(() =>
			Outcome.from(result)
				.andThen((job) => ok({ ...job, step1: true }))
				.andThen(() => {
					// Simulate error in chain - return error Result
					return err("Chain error");
				})
				.map((job) => ({
					...(job as JobOccupation & { step1: boolean }),
					step3: true,
				}))
				.unwrap(),
		).toThrow("Chain error");
	});

	it("should combine map and mapErr", async () => {
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
			.map((job) => ({ ...job, processedAt: new Date() })) // Transform on success
			.mapErr((error) => `Failed to fetch job: ${error}`) // Transform error message
			.unwrap(); // Get final value or throw

		expect(transformed.processedAt).toBeInstanceOf(Date);
		expect(transformed.id).toBe("job-123");
	});

	it("should handle complex transformation pipeline", async () => {
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

		const final = Outcome.from(result)
			.map((job) => ({
				...job,
				metadata: { fetchedAt: new Date() },
			}))
			.andThen((job) => ok({ ...job, validated: true }))
			.map((job) => ({
				...job,
				formatted: {
					display: `${job.title} - ${job.id}`,
				},
			}))
			.unwrap();

		expect(final.id).toBe("job-123");
		expect(final.validated).toBe(true);
		expect(final.metadata.fetchedAt).toBeInstanceOf(Date);
		expect(final.formatted.display).toBe("Software Engineer - job-123");
	});
});

