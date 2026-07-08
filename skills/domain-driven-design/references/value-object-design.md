# Value Object Design

Use value object design when modeling a domain concept defined by its
attributes rather than by identity. The goal is a well-formed value object:
immutable, self-validating, structurally compared, and rich with
side-effect-free behavior.

This reference has two parts. Part 1 - Principles are invariants: they always
hold, no choice involved. Some principles state a standing default and name the
Part 2 procedure that governs any deviation. Part 2 - Decision procedures are
forks resolved per value object, attribute, or behavior. Each procedure names
its discriminator, gives ordered options with observable conditions, and states
its hard limits. A sequence is run in full; a fork is entered at the matching
condition.

## Scope and Neighbors

This document covers two things: deciding whether a concept qualifies as a value
object at all, and modeling it well once it does.

- Whether a concept is a value object or an entity is decided here, in *What
  Qualifies as a Value Object* and *Value Object Qualification*, and mirrored in
  `entity-design.md`. `aggregate-design.md` defers to both for that judgment.
- A value object lives inside an entity or aggregate; it is never an aggregate
  root and has no repository. See `aggregate-design.md`.
- Cross-instance and set-based invariants belong to an aggregate or a set-level
  guard, never to a value object; see `aggregate-design.md`.
- Value objects often appear as facts in event payloads; see
  `domain-event-design.md`.

## Contents

- Core rule
- Part 1 - Principles
  - What a value object is
  - What qualifies as a value object
  - Immutability
  - Equality
  - Validity and construction
  - Behavior
  - Wholeness and composition
  - Relationship to entities and aggregates
  - Persistence
- Part 2 - Decision procedures
  - Value object qualification
  - Value object modeling
  - Construction and validation
  - Equality scope
  - Behavior placement
- Design checklist
- Smell checks
- Expected output

## Core Rule

A value object is a domain concept defined entirely by its attributes, with no
identity. Two value objects with equal attributes are equal and interchangeable.
It is immutable, validates itself at construction, and once created is always
valid. Model it as a conceptual whole with side-effect-free behavior, living
inside an entity or aggregate.

## Part 1 - Principles

### What a Value Object Is

- Defined by its attributes, not by identity or continuity through time.
- Immutable: it is never mutated after construction; a "change" is a new
  instance.
- Compared by structure: two instances with equal attributes are equal and
  interchangeable.
- A descriptive or quantitative whole: Money, DateRange, EmailAddress,
  Quantity, GeoCoordinate.
- No independent lifecycle, no repository: it is persisted only as part of an
  owning entity or aggregate. Transiently it appears anywhere: as a command
  parameter, a computation result, or a fact in an event payload.

### What Qualifies as a Value Object

A concept is a value object when all of these hold:

- It is defined entirely by its attributes.
- Two instances with equal attribute values are interchangeable.
- Nothing needs to track or reference it by identity over time.
- A change is expressed by replacing it wholesale, not by mutating it.

A concept is not a value object; it is an entity when:

- It must remain the same thing across attribute changes, with continuity of
  identity.
- Two instances with equal values must still be told apart.
- It has a lifecycle the model tracks, or is referenced or retrieved by
  identity.

Two constraints bound the judgment:

- Classification is per bounded context. The same real-world thing may be a
  value object in one context and an entity in another. An address can be a
  value object in shipping and an entity in a land registry. Classify for this
  context.
- Storage shape is not evidence. Being stored in its own table, or having a
  surrogate key for persistence convenience, does not make a concept an entity.
  Classify from behavior. A set-based uniqueness rule is not identity; it is a
  set invariant. See `aggregate-design.md`.

### Immutability

- All fields are set once at construction and never change; there are no
  setters.
- A method that "modifies" the value returns a new instance instead of mutating
  the receiver.
- A truly immutable value object is safe to share, cache, and reuse without
  defensive copying.

### Equality

- Two value objects are equal when all their value-defining attributes are
  equal: structural equality.
- Equality and hashing are implemented over the same value-defining attributes
  and must agree, so the value object is safe as a map key or set member.
- A value object has no identity; equal instances are the same value. Never
  compare value objects by reference or by an identity field.

### Validity and Construction

- A value object validates all its invariants at construction. An invalid value
  object cannot exist.
- Construction is total: it either yields a valid value or fails. There is no
  half-built or temporarily invalid state.
- Once constructed, a value object is always valid; consumers never re-check it.
- Input validation happens at the single construction path, not scattered across
  callers.

### Behavior

- A value object may carry domain behavior, but that behavior is
  side-effect-free: it computes or returns new value objects and mutates
  nothing.
- Put logic about the value on the value object, such as `Money.add`,
  `DateRange.overlaps`, or `Percentage.of`, rather than in a service.
- A value object performs no I/O, no persistence, and reads no system clock.
  Pass time or external inputs in as parameters or value objects.

### Wholeness and Composition

- A value object models a conceptual whole: attributes that only make sense
  together, such as amount and currency, start and end, latitude and longitude.
- Value objects compose: a value object may contain other value objects.
- Do not scatter a whole value across loose primitives on the owning entity.

### Relationship to Entities and Aggregates

- A value object lives inside an entity or aggregate. It is never an aggregate
  root and has no repository of its own.
- It has no independent lifecycle; it exists only as part of its owner.
- It may hold a typed identifier of another aggregate as a value. A typed ID is
  itself a value object. It never holds a live object reference to an entity and
  does not navigate the aggregate graph.
- It carries no cross-instance or set-based invariant; that is aggregate or
  set-level territory.

### Persistence

- A value object is persisted as part of its owner: embedded or inlined, not
  loaded independently as a root.
- It has no domain identity; any storage key is an implementation detail, not a
  domain concept.
- Reconstitution rebuilds it from its stored attributes and it still satisfies
  its construction invariants.

## Part 2 - Decision Procedures

### Value Object Qualification - fork

Discriminator: is the concept defined entirely by its values, with equal-valued
instances interchangeable and nothing tracking it by identity over time?

1. Yes: it is a value object. Model it with *Value Object Modeling*.
2. No, it must stay the same thing across attribute changes, or two equal-valued
   instances must be told apart, or it has a tracked lifecycle: it is likely an
   entity, out of scope here. Confirm via *Entity Qualification* in
   `entity-design.md`.
3. It depends on the context: classify per bounded context, deciding by 1-2 for
   this one. The same real-world thing may be classified differently elsewhere;
   link across contexts by reference.

Hard limits:

- A storage key or its own table qualifies nothing; classify from behavior.
- A mutable business value that must be unique, such as email or username, is a
  unique attribute of an entity, not automatically a value object. Its
  uniqueness is a set invariant, not identity.
- If two equal-valued instances must ever be distinguished, it is not a value
  object.

### Value Object Modeling - sequence

Goal: model a concept confirmed as a value object, via *Value Object
Qualification*, into a well-formed one.

1. Identify the whole: which attributes belong together as one conceptual value.
2. Make every field immutable; remove all setters.
3. Validate all invariants in a single construction path; fail on invalid input;
   expose a named factory or constructor (*Construction and Validation*).
4. Implement structural equality and hashing over the value-defining attributes
   (*Equality Scope*).
5. Add side-effect-free behavior that returns new value objects
   (*Behavior Placement*).
6. Compose from other value objects where a sub-value is itself a whole, rather
   than from loose primitives.
7. Confirm it lives inside an entity or aggregate, with no repository and no
   independent lifecycle.

### Construction and Validation - fork

Discriminator: can every invalid input be rejected at construction, and how
should invalid input surface?

1. Total constructor or factory that throws on invalid input: the default. It
   guarantees an always-valid value object and is right when invalid input is a
   defect or programmer error.
2. Smart constructor returning a Result when invalid input is an expected,
   user-correctable outcome, so the failure is explicit in the contract. This
   ties to the error contract in `aggregate-design.md`.
3. Parse, don't validate: accept raw input at the edge, construct the value
   object once, then pass the typed value object inward so nothing downstream
   re-validates.

Hard limits: no public path can build an invalid value object; validation lives
in one place, not duplicated across callers; there is no mutable-then-frozen
construction exposed to callers.

### Equality Scope - fork

Discriminator: which attributes define the value?

1. All attributes define the value: equality and hashing over all of them. This
   is the default.
2. Some attributes are derived or cached: exclude them. Equality is over the
   defining inputs only, so two values computed differently but meaning the same
   compare equal.
3. Representations differ but mean the same, such as case-insensitive email,
   trimmed text, or a canonical unit: normalize at construction so equal values
   are structurally equal, and compare the normalized form.

Hard limits: equality and hashing must agree; never include identity-like or
mutable fields in equality; normalization happens at construction, never inside
the equality method.

### Behavior Placement - fork

Discriminator: is the logic about the value itself, or about a process across
values or entities?

1. Intrinsic to the value, such as adding money, extending a range, formatting,
   or converting: use a method on the value object that returns a new value
   object.
2. Combining the value with entity or aggregate state: put behavior on the
   entity or aggregate, taking the value object as input.
3. Coordinating multiple aggregates: use a domain service; the value object
   stays a passive input.

Hard limits: value object methods are side-effect-free and return new
instances; a value object mutates nothing, including itself; no I/O,
persistence, or clock access inside a value object. Pass such inputs in.

## Design Checklist

This restates Part 1 and Part 2 as a post-design review pass, to run once a
value object is drafted. It is a mirror, not the source of truth: on any
conflict, Part 1 and Part 2 govern. Each item checks a property of the finished
design.

- The concept qualifies as a value object: defined by its values, equal-valued
  instances interchangeable, no identity tracked, rather than an entity, and the
  judgment holds for this bounded context.
- All fields are immutable; there are no setters.
- Equality and hashing are structural, over the value-defining attributes, and
  agree with each other.
- The value object validates all its invariants in one construction path; an
  invalid instance cannot be built.
- Once constructed it is always valid; consumers do not re-check it.
- Behavior is side-effect-free; methods that "modify" return new instances.
- There is no I/O, persistence, or system-clock access inside the value object;
  such inputs are passed in.
- It models a conceptual whole; related attributes are not scattered as
  primitives on the owner.
- It composes from other value objects where a sub-value is itself a whole.
- It holds values and typed IDs, never live object references to entities.
- It has no repository and no independent lifecycle; it is persisted as part of
  its owner.
- It carries no cross-instance or set-based invariant.
- Derived or cached fields are excluded from equality; normalization happens at
  construction.
- Reconstitution rebuilds it from stored attributes and it still satisfies its
  invariants.

## Smell Checks

- A concept with continuity of identity is modeled as a value object instead of
  an entity.
- The value object exposes setters or is mutated after construction.
- Equality is by reference or by an identity field instead of by attributes.
- Equality and hashing disagree, or mutable fields are included in equality.
- An invalid value object can be constructed, or validation lives outside it or
  is duplicated across callers.
- A "modifying" method mutates the instance instead of returning a new one.
- The value object performs I/O, reads the clock, or touches persistence.
- A whole value is split into loose primitives on the owning entity.
- The value object holds a live object reference to an entity or navigates the
  aggregate graph.
- The value object has its own repository or is loaded independently as a root.
- The value object carries a cross-instance or set-based uniqueness rule.

## Expected Output

When designing a value object, define:

- The qualification: why it is a value object rather than an entity, and in
  which bounded context.
- The conceptual whole: which attributes define the value.
- The immutability approach.
- Construction and validation strategy: total constructor, Result, or
  parse-don't-validate.
- Equality basis: which attributes, and any normalization at construction.
- Side-effect-free behavior it carries.
- Composition from other value objects.
- Any typed identifiers it holds as values.
- How it is persisted as part of its owner.
- Deviations from the defaults and their business reason.
