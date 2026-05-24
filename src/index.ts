// Core utilities


// Aggregates
export * from "./aggregate/aggregate";
export * from "./aggregate/aggregate-root";
export * from "./aggregate/event-sourced-aggregate";
// CQRS - Commands and Queries
export * from "./app/command";
export * from "./app/command-bus";
// App handlers
export * from "./app/handler";
export * from "./app/query";
export * from "./app/query-bus";
export * from "./core/errors";
export * from "./core/id";
// Result types come from the peer dependency `@shirudo/result` — import directly from there.
// Entities
export * from "./entity/entity";
export * from "./events/event-bus";
export * from "./events/outbox";
// Events
export * from "./events/ports";
// Repository
export * from "./repo/repository";
export * from "./repo/scope";
// Value Objects
export * from "./value-object/value-object";
// Utils
export * from "./utils";

