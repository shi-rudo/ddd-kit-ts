import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vite-plus/test/node";

declare module "vitest" {
	export interface ProvidedContext {
		postgresUri: string;
	}
}

export async function setup(
	project: TestProject,
): Promise<() => Promise<void>> {
	const container = await new PostgreSqlContainer("postgres:18-alpine").start();
	project.provide("postgresUri", container.getConnectionUri());
	return async () => {
		await container.stop();
	};
}
