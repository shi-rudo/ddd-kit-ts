import { describe, expect, it } from "vitest";
import type { Query } from "../../src/app/query";
import { QueryBus } from "../../src/app/query-bus";
import { Outcome } from "../../src/core/result/outcome";

/**
 * Option 2: Using match() - Explicit Error Handling
 * 
 * This test demonstrates explicit handling of both success and error cases
 */
describe("Option 2: Using match()", () => {
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

	it("should return value on success", async () => {
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

		const job = Outcome.from(result).match(
			(value) => value, // Success: return value
			(error) => {
				throw new Error(error);
			}, // Error: throw exception
		);

		expect(job).toEqual(mockJob);
		expect(job.id).toBe("job-123");
	});

	it("should handle error case explicitly", async () => {
		const bus = new QueryBus<QueryMap>();
		// No handler registered

		const result = await bus.execute({
			type: "GetJobOccupation",
			jobId: "job-123",
		});

		let errorThrown = false;
		let errorMessage = "";

		Outcome.from(result).match(
			(value) => {
				// Should not reach here
				expect.fail("Should not have succeeded");
			},
			(error) => {
				errorThrown = true;
				errorMessage = error;
			},
		);

		expect(errorThrown).toBe(true);
		expect(errorMessage).toContain("No handler registered");
	});

	it("should allow custom error transformation", async () => {
		const bus = new QueryBus<QueryMap>();
		// No handler registered

		const result = await bus.execute({
			type: "GetJobOccupation",
			jobId: "job-123",
		});

		type Response =
			| { success: true; data: JobOccupation }
			| { success: false; error: string };

		const response = Outcome.from(result).match<Response>(
			(value) => ({ success: true, data: value }),
			(error) => ({ success: false, error: `Custom: ${error}` }),
		);

		expect(response.success).toBe(false);
		if (!response.success) {
			expect(response.error).toContain("Custom:");
			expect(response.error).toContain("No handler registered");
		}
	});

	it("should allow throwing custom exceptions", async () => {
		const bus = new QueryBus<QueryMap>();
		// No handler registered

		const result = await bus.execute({
			type: "GetJobOccupation",
			jobId: "job-123",
		});

		expect(() =>
			Outcome.from(result).match(
				(value) => value,
				(error) => {
					throw new Error(`Query failed: ${error}`);
				},
			),
		).toThrow(/Query failed:/);
	});
});

