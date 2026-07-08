# Entity Design

Use entity design when modeling a domain object defined by identity and
continuity through time. The goal is a well-formed entity: stable identity,
value objects for constrained attributes, explicit lifecycle, and local
invariants protected by behavior.

This reference has two parts. Part 1 - Principles are invariants: they always
hold, no choice involved. Some principles state a standing default and name the
Part 2 procedure that governs any deviation. Part 2 - Decision procedures are
forks resolved per entity, member, identity, or relationship. Each procedure
names its discriminator, gives ordered options with observable conditions, and
states its hard limits. A sequence is run in full; a fork is entered at the
matching condition.

## Scope and Neighbors

This document covers two things: deciding whether a concept qualifies as an
entity at all, and modeling it well once it does.

- Whether a concept is an entity, a value object, or reference data is decided
  here, in *What Qualifies as an Entity* and *Entity Qualification*.
  `value-object-design.md` mirrors the value-object side of that judgment, and
  `aggregate-design.md` defers to both documents.
- Whether an entity is its own aggregate or a child inside one is a boundary
  question answered by *Size Decision* in `aggregate-design.md`.
- Cross-entity and set-based invariants belong to the aggregate root, not the
  entity; see `aggregate-design.md`.
- Domain events recorded by an entity's behavior are modeled per
  `domain-event-design.md`.

## Contents

- Core rule
- Part 1 - Principles
  - What an entity is
  - What qualifies as an entity
  - Identity
  - Equality
  - State and lifecycle
  - Local invariants and behavior
  - Composition
  - References and relationships
  - Persistence and reconstitution
- Part 2 - Decision procedures
  - Entity qualification
  - Entity modeling
  - Identity generation
  - Identity source
  - Member modeling
  - State and lifecycle
  - Relationships and references
- Design checklist
- Smell checks
- Expected output

## Core Rule

An entity is a domain object defined by a stable identity that persists through
changes to its attributes and through its lifecycle. Two entities are the same
when they share identity, regardless of attribute values. Model the entity
around that identity, the value objects it is composed of, and the local
invariants and behavior it owns.

## Part 1 - Principles

### What an Entity Is

- Defined by identity and continuity through time, not by its attribute values.
- Has a lifecycle: it is created, changes state, and eventually ends.
- Mutated only through behavior. Its identity does not change even as its state
  does.
- Distinct from a value object, which is defined by its attributes and is
  immutable and interchangeable.
- Being an entity says nothing about its boundary. Whether it is an aggregate
  root or a child inside one is settled in `aggregate-design.md`.

### What Qualifies as an Entity

A concept is an entity when both defining conditions hold:

- It must remain the same thing over time while its attributes change; it has a
  thread of continuity.
- Two instances with identical attribute values are still different things that
  must be told apart.

And at least one corroborating condition confirms the judgment:

- It has a lifecycle the model tracks: created, changed, ended.
- Something in the domain needs to reference or retrieve it by identity.

A concept is not an entity; it is a value object when:

- It is defined entirely by its attributes.
- Two instances with equal values are interchangeable.
- Change means replacement, not mutation: it is immutable and replaced
  wholesale.
- Nothing needs to track it by identity over time.

Two constraints bound the judgment:

- Classification is per bounded context. The same real-world thing may be an
  entity in one context and a value object in another. An address can be a value
  object in shipping and an entity in a land registry. Classify for this
  context; link to another context by reference, not by sharing the object.
- Storage shape is not evidence. A primary key, a table row, or an ORM entity
  does not make a concept an entity. Immutable, widely referenced master data is
  usually reference data or a value object. A set-based uniqueness rule is not
  entity identity; it is a set invariant. Classify from behavior.

### Identity

- Every entity has an explicit, stable identity, modeled as a typed ID, not a
  raw primitive.
- Identity is assigned once and never changes for the life of the entity.
- Identity is intrinsic. It does not depend on mutable attributes. Do not derive
  identity from values that can change, such as email, name, or phone.
- Identity is scoped to a bounded context. The same real-world thing may be a
  distinct entity with distinct identity in another context; link across
  contexts by reference, never by sharing the object.
- A child entity's identity need only be unique within its aggregate. An
  aggregate root's identity is unique within its bounded context.

### Equality

- Entities compare by identity, not by value. Two loaded instances with the same
  ID are the same entity.
- Do not implement value-style structural equality on an entity; it breaks
  identity maps and deduplication.
- Never decide entity identity from attribute equality, including for
  deduplication or upsert.

### State and Lifecycle

- Lifecycle states are explicit when later decisions, audits, transitions, or
  events depend on the stage.
- State transitions happen through named behavior that guards the transition and
  rejects illegal ones.
- Do not represent lifecycle as free-form mutable flags that any code can set.
- State that is a pure function of other attributes is derived, not stored.
- Time-based transitions receive an explicit clock or current-time input; system
  time is never read inside entity methods.

### Local Invariants and Behavior

- An entity protects its own local invariants, those expressible with its own
  state alone.
- Cross-entity invariants belong to the aggregate root, not the entity; see
  `aggregate-design.md`.
- Expose behavior as named domain decisions. Do not expose public setters unless
  a setter is itself a named decision protecting a named invariant.
- Do not expose mutable internal collections.
- An entity with only getters and setters and no behavior or invariant is
  anemic. Either it owns behavior and invariants, or it is really a value object
  or a data holder.

### Composition

- Model constrained, validated, or compound attributes as value objects, not
  primitives.
- The entity owns the coherence of the value objects and child entities it
  contains.
- Reach for a value object before a raw primitive; primitive obsession is a
  smell.

### References and Relationships

- Within one aggregate, entities may hold direct references to sibling or child
  entities, because they load and change together.
- References to entities in other aggregates are by identity, using typed IDs,
  never stored object references.
- A child entity is reached and mutated only through the aggregate root, never
  directly by outside code.
- A child entity does not reference back out to command its root.

### Persistence and Reconstitution

- Reconstitution restores an entity's identity and state. Identity is stable
  across reconstitution.
- Reconstitution does not mint a new identity, represent a new business
  decision, or record new domain events.
- The storage surrogate key is a persistence detail; the domain identity is the
  typed ID. A database primary key does not by itself make something an entity.

## Part 2 - Decision Procedures

### Entity Qualification - fork

Discriminator: must this concept stay identifiable as the same thing across
attribute changes, and must two instances with equal values be told apart?

1. Yes to both: it is an entity, once at least one corroborating condition from
   *What Qualifies as an Entity* is confirmed: the model tracks its lifecycle,
   or something in the domain references or retrieves it by identity. If
   neither holds, recheck options 2 and 3. Then model it with *Entity Modeling*.
2. No, it is defined by its values, interchangeable when values are equal, and
   changed by wholesale replacement: it is a value object, out of scope here.
   Model it with `value-object-design.md`.
3. Immutable master data used only for lookup, with no protected writes:
   reference data or a read model, not an entity. See *Reference Decision* and
   *Reclassification and Audit* in `aggregate-design.md`.
4. It depends on the context: classify per bounded context, deciding by 1-3 for
   this one. The same real-world thing may be classified differently elsewhere;
   link across contexts by reference, never by sharing the object.

Hard limits:

- A storage primary key qualifies nothing as an entity. Classify from behavior.
- Identity derived only from mutable attributes is not real identity. If you
  cannot name a stable identity the concept keeps across attribute changes, it
  is probably a value object.
- Set-based uniqueness is not entity identity; it is a set invariant, resolved
  in `aggregate-design.md`.

### Entity Modeling - sequence

Goal: model an object already confirmed as an entity, via *Entity
Qualification*, into a well-formed one.

1. Assign identity: choose the identity source (*Identity Source*) and how it is
   generated (*Identity Generation*), modeled as a typed ID.
2. Set equality to identity only.
3. Classify each member: raw primitive, value object, child entity, or reference
   by ID (*Member Modeling*).
4. Make lifecycle states explicit where decisions depend on them, with guarded
   transitions (*State and Lifecycle*).
5. Express the entity's local invariants as named guarded behavior. Remove
   public setters and exposed mutable collections.
6. Wire relationships: direct references within the aggregate, typed IDs across
   aggregates (*Relationships and References*).
7. Confirm the boundary: is this entity its own aggregate or a child? Use *Size
   Decision* in `aggregate-design.md`.

### Identity Generation - fork

Discriminator: who assigns the identity, and when is it needed?

1. Application- or domain-assigned identity, such as UUID or ULID, before
   persistence, when the identity is needed immediately: to reference the
   entity, put it in a domain event, or return it before commit. Default in
   event-driven or distributed designs.
2. Database-generated identity, such as an identity or sequence column, when
   identity can wait until insert and a single writer assigns it. Simpler and
   ordered, but not available until the row is inserted, after the domain
   decision has already run.
3. Identity provided by another bounded context or external system when that
   system owns the identity. Store it as a typed reference; do not re-mint it.
4. Local or composite identity for a child entity that only needs to be unique
   within its aggregate.

Hard limits: identity is assigned once and never changes; never derive it from a
mutable attribute; if the ID must appear in a domain event recorded in the same
transaction, assign it in the domain. A post-insert database ID is too late.

### Identity Source - fork

Discriminator: is there a business identifier that is unique, stable, and never
changes?

1. Surrogate key, a generated ID: the default. It decouples identity from
   business data.
2. Natural key only when a business identifier is genuinely immutable, unique,
   and treated as identity by the domain: rare cases such as a country code or
   ISBN.
3. Surrogate identity plus a uniqueness constraint on the business value when
   the value must be unique but can change, or you do not want it as identity:
   email, username, order number. The uniqueness is a set-based invariant, not
   identity.

Hard limit: never adopt email, phone, username, or name as identity. A mutable
business identifier is a unique attribute, not an identity.

### Member Modeling - fork

Discriminator: what kind of member is this field?

1. Value object when the value is constrained, validated, compound, or has
   behavior: Money, EmailAddress, DateRange, Quantity. The default for almost
   every attribute.
2. Raw primitive only for a genuinely unconstrained scalar with no rules, such
   as a free-text note.
3. Child entity when the member has its own identity that must persist and its
   own lifecycle.
4. Reference by typed ID when the member is another aggregate.

Hard limits: primitive obsession is a smell; reach for a value object first. A
collection of child entities stays encapsulated, never exposed as a mutable
collection. A member that is another aggregate is never held as a direct object
reference.

### State and Lifecycle - fork

Discriminator: do later decisions depend on the stage, and is the stage stored
or derivable?

1. Derived state when the stage is a pure function of existing attributes:
   compute it, do not store it, to avoid two sources of truth.
2. Explicit stored state with guarded transitions when transitions carry rules
   or side effects.
3. Explicit state machine when there are several states with constrained legal
   transitions.
4. A single timestamp or boolean when it is one irreversible step, such as
   `cancelledAt`.

Hard limits: transitions go through named guarded behavior, never a public
setter; illegal transitions are rejected explicitly; do not store what can be
derived; time input is explicit.

### Relationships and References - fork

Discriminator: is the related entity in the same aggregate or a different one?

1. Same aggregate: hold a direct reference; navigate and mutate only through the
   root; the related entity loads and saves with the root.
2. Different aggregate: hold a typed ID; load it separately; never traverse into
   its internals or mutate it from here.
3. Bidirectional links only within one aggregate, and only when a real invariant
   needs both directions; otherwise keep a single direction.

Hard limits: no object references across an aggregate boundary; no outside code
holding or mutating a child entity directly; a child entity does not reference
back out to drive its root's behavior.

## Design Checklist

This restates Part 1 and Part 2 as a post-design review pass, to run once an
entity is drafted. It is a mirror, not the source of truth: on any conflict,
Part 1 and Part 2 govern. Each item checks a property of the finished design.

- The concept qualifies as an entity: continuity of identity through attribute
  change, not definition by its values, rather than a value object or reference
  data, and the judgment holds for this bounded context.
- The entity has an explicit, stable, typed identity, not a raw primitive.
- Identity is assigned once and never changes, and is not derived from a mutable
  attribute.
- Equality is by identity only; there is no value-style equality on the entity.
- The identity generation strategy is chosen and matches when the ID is needed.
- A natural key is identity only when truly immutable and unique; otherwise a
  surrogate ID with a uniqueness constraint on the business value.
- Constrained attributes are value objects, not primitives.
- Members with their own identity and lifecycle are child entities; members that
  are other aggregates are held by typed ID.
- Lifecycle states are explicit where later decisions depend on them; derived
  state is computed, not stored.
- Transitions go through named guarded behavior; illegal transitions are
  rejected; there is no public state setter.
- The entity protects its own local invariants; cross-entity invariants live on
  the aggregate root.
- Behavior is exposed as named domain decisions; no public setters or exposed
  mutable collections.
- The entity is not anemic: it owns behavior or invariants, or it is
  reclassified as a value object or data holder.
- References within the aggregate are direct; references across aggregates are
  by typed ID, not object references.
- A child entity is reached and mutated only through the aggregate root, and
  does not command its root.
- Reconstitution restores identity and state without minting new identity or
  recording new facts.
- Domain identity is distinct from the storage surrogate key; classification is
  from behavior, not schema.
- Time-based transitions receive an explicit clock or current-time input.
- Whether the entity is its own aggregate or a child is settled via
  `aggregate-design.md` and recorded.

## Smell Checks

- Identity is a raw primitive instead of a typed ID.
- A concept defined entirely by its values is modeled as an entity instead of a
  value object.
- A concept is treated as an entity only because it has a database row or
  primary key.
- Identity is derived from or equal to a mutable attribute such as email or
  name.
- The entity implements value-style equality, breaking identity maps and
  deduplication.
- A mutable business value such as email or username is used as the primary
  identity.
- Attributes are raw primitives where value objects belong.
- Lifecycle is a free-form mutable flag any code can set.
- State that could be derived is stored, creating two sources of truth.
- State transitions happen through setters without guarding illegal transitions.
- The entity is anemic: only getters and setters, no behavior or invariant.
- A child entity is loaded or mutated directly by outside code, bypassing the
  root.
- The entity holds a direct object reference to an entity in another aggregate.
- A child entity references back out to drive its root's behavior.
- Domain identity is conflated with the database surrogate key.
- Reconstitution assigns a new identity or records new domain events.

## Expected Output

When designing an entity, define:

- The qualification: why it is an entity rather than a value object or reference
  data, and in which bounded context.
- The entity and its typed identity.
- Identity generation strategy and when the ID is needed.
- Identity source: surrogate or natural, with any uniqueness constraint on
  business values.
- Equality basis: identity.
- Each member classified: primitive, value object, child entity, or reference by
  ID.
- Local invariants the entity protects and the guarded behavior that protects
  them.
- Lifecycle states and legal transitions, if any.
- Relationships: direct within-aggregate references and cross-aggregate ID
  references.
- Reconstitution behavior for identity and state.
- Boundary decision: own aggregate or child, resolved via `aggregate-design.md`.
- Deviations from the defaults and their business reason.
