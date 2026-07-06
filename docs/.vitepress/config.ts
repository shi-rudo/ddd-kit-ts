import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import llmstxt from "vitepress-plugin-llms";

// typedoc-vitepress-theme writes the API sidebar to this file as part of
// `pnpm docs:api`. Read it lazily so a fresh checkout (where docs/api/ is
// gitignored and not yet generated) still loads the config; the API
// sidebar just appears empty until `docs:api` has run.
const typedocSidebarPath = fileURLToPath(
	new URL("../api/typedoc-sidebar.json", import.meta.url),
);
const typedocSidebar = existsSync(typedocSidebarPath)
	? (JSON.parse(readFileSync(typedocSidebarPath, "utf-8")) as Array<unknown>)
	: [];

export default defineConfig({
	title: "ddd-kit",
	description:
		"Composable TypeScript toolkit for tactical Domain-Driven Design",
	lang: "en-US",

	// Set to the repo name when deploying to https://shi-rudo.github.io/ddd-kit-ts/
	base: "/ddd-kit-ts/",

	cleanUrls: true,
	lastUpdated: true,
	ignoreDeadLinks: [/^\.\/(aggregates|unit-of-work|outbox|concurrency)$/],

	// Emit llms.txt (sitemap index) and llms-full.txt (full docs concat)
	// at the docs site root for LLM coding tools. The hand-curated LLM
	// integration guide lives at /LLM.md in the repo root (audience: tools
	// that read directly from the GitHub repo, not the deployed docs site).
	vite: {
		plugins: [llmstxt()],
	},

	head: [
		[
			"link",
			{
				rel: "icon",
				href: "/ddd-kit-ts/favicon.svg",
				type: "image/svg+xml",
			},
		],
	],

	themeConfig: {
		nav: [
			{ text: "Guide", link: "/guide/getting-started" },
			{ text: "API", link: "/api/" },
			{
				text: "2.1.0",
				items: [
					{
						text: "Changelog",
						link: "https://github.com/shi-rudo/ddd-kit-ts/blob/main/CHANGELOG.md",
					},
					{
						text: "npm",
						link: "https://www.npmjs.com/package/@shirudo/ddd-kit",
					},
				],
			},
		],

		sidebar: {
			"/guide/": [
				{
					text: "Introduction",
					items: [
						{ text: "Getting Started", link: "/guide/getting-started" },
						{ text: "Design Decisions", link: "/guide/design-decisions" },
					],
				},
				{
					text: "Building Blocks",
					items: [
						{ text: "Value Objects", link: "/guide/value-objects" },
						{ text: "Money", link: "/guide/money" },
						{ text: "Entities", link: "/guide/entities" },
						{ text: "Aggregate Roots", link: "/guide/aggregates" },
						{ text: "Event Sourcing", link: "/guide/event-sourcing" },
						{ text: "Domain Events", link: "/guide/domain-events" },
						{
							text: "Domain State Machine",
							link: "/guide/domain-state-machine",
						},
					],
				},
				{
					text: "Application Layer",
					items: [
						{ text: "Result vs Throw", link: "/guide/result-vs-throw" },
						{ text: "CQRS & Buses", link: "/guide/cqrs-and-buses" },
						{ text: "Repository", link: "/guide/repository" },
						{ text: "Unit of Work", link: "/guide/unit-of-work" },
						{ text: "Outbox & Transactions", link: "/guide/outbox" },
						{ text: "Read-Side Projections", link: "/guide/projections" },
					],
				},
				{
					text: "Advanced",
					items: [
						{ text: "Event Upcasting", link: "/guide/event-upcasting" },
						{ text: "Concurrency", link: "/guide/concurrency" },
						{ text: "Edge Runtimes", link: "/guide/edge-runtimes" },
					],
				},
				{
					text: "Reference",
					items: [
						{ text: "Common Mistakes", link: "/guide/common-mistakes" },
					],
				},
			],
			"/api/": [
				{
					text: "API Reference",
					link: "/api/",
					items: typedocSidebar as Array<{
						text: string;
						link?: string;
						items?: unknown[];
					}>,
				},
			],
		},

		socialLinks: [
			{ icon: "github", link: "https://github.com/shi-rudo/ddd-kit-ts" },
		],

		editLink: {
			pattern:
				"https://github.com/shi-rudo/ddd-kit-ts/edit/main/docs/:path",
			text: "Edit this page on GitHub",
		},

		footer: {
			message: "Released under the MIT License",
			copyright: "Copyright © Shirudo",
		},

		search: {
			provider: "local",
		},
	},
});
