import { describe, expect, it } from "vitest";
import { isOk } from "../../src/core/result/result";
import type { Query } from "../../src/app/query";
import { QueryBus } from "../../src/app/query-bus";

/**
 * Option 3: Functional API (Without Outcome)
 * 
 * This test demonstrates the functional style without class-based API
 */
describe("Option 3: Functional API", () => {
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

		if (!isOk(result)) {
			throw new Error(result.error);
		}

		expect(result.value).toEqual(mockJob);
		expect(result.value.id).toBe("job-123");
	});

	it("should throw error when query fails", async () => {
		const bus = new QueryBus();
		// No handler registered

		const result = await bus.execute({
			type: "GetJobOccupation",
			jobId: "job-123",
		});

		if (!isOk(result)) {
			expect(result.error).toContain("No handler registered");
			expect(() => {
				throw new Error(result.error);
			}).toThrow(/No handler registered/);
		} else {
			expect.fail("Should have failed");
		}
	});

	it("should work with early return pattern", async () => {
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

		if (!isOk(result)) {
			throw new Error(result.error);
		}

		// TypeScript knows result.value is JobOccupation here
		const processed = {
			...result.value,
			processed: true,
		};

		expect(processed.processed).toBe(true);
		expect(processed.id).toBe("job-123");
	});

	it("should handle multiple queries with type guards", async () => {
		const bus = new QueryBus();
		const mockJob: JobOccupation = {
			id: "job-123",
			title: "Software Engineer",
			description: "Build amazing software",
		};

		bus.register("GetJobOccupation", async () => mockJob);

		const result1 = await bus.execute({
			type: "GetJobOccupation",
			jobId: "job-123",
		});

		if (!isOk(result1)) {
			throw new Error(result1.error);
		}

		const result2 = await bus.execute({
			type: "GetJobOccupation",
			jobId: "job-456",
		});

		if (!isOk(result2)) {
			throw new Error(result2.error);
		}

		expect(result1.value.id).toBe("job-123");
		expect(result2.value.id).toBe("job-123"); // Same mock
	});
});

