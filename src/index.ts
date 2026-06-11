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
export * from "./app/unit-of-work";
export * from "./app/query-bus";
export * from "./core/errors";
export * from "./core/id";
// Entities
export * from "./entity/entity";
export * from "./events/event-bus";
export * from "./events/outbox";
// Events
export * from "./events/ports";
// Repository
export * from "./repo/repository";
export * from "./repo/scope";
// Utils
export * from "./utils";
// Result types come from the peer dependency `@shirudo/result`; import directly from there.
// `ValidationError` comes from the peer dependency `@shirudo/base-error`; import directly from there.
// RFC 9457 Problem Details presenters live in the opt-in `@shirudo/ddd-kit/http` entry point.
// Validation
export * from "./validation";
// Value Objects
export * from "./value-object/value-object";
