# Domain-event recording benchmark

This benchmark measures the complete in-memory path from an aggregate decision
to a recorded event:

1. create and freeze an `UncommittedDomainEvent`;
2. create a factory-owned or hand-built `DomainEventStamp`;
3. record the final `DomainEvent`.

Run it with:

```bash
pnpm benchmark:event-stamping
```

The command builds the package and runs
`benchmarks/domain-event-stamping.mjs` with `--expose-gc`. Each case warms the
runtime first. Throughput includes transient cloning and freezing work.
Retained bytes are the heap delta after a forced collection while every final
event remains reachable; they are useful for comparing final graph size, not
as a count of temporary allocations.

## Optimization threshold

The factory path is the normal production path. Additional internal ownership
machinery is justified only when duplicate defensive copying makes that path at
least 15% slower than a hand-built stamp for the medium or deeply nested case.
A difference below that threshold is too sensitive to runtime noise to warrant
more lifecycle complexity.

The initial measurement crossed the threshold: factory stamps performed about
22% fewer operations per second for medium data and 28% fewer for deeply
nested data. The cause was visible in the implementation: the factory cloned
and froze owned metadata, after which final recording cloned the same metadata
again and also recloned the already owned decision payload.

Factory-created stamps now carry a non-enumerable internal ownership brand.
Recording can share their already immutable metadata and the decision's already
immutable payload. Public hand-built stamps still take the defensive-copy path.
The event always receives its own frozen `Date`. Mutation and aliasing tests pin
those ownership guarantees.

## Result after the change

Measured on 2026-07-24 with Node v24.11.1 on macOS arm64:

| Case | Iterations | Operations/s | Retained bytes/event |
| --- | ---: | ---: | ---: |
| small / factory stamp | 40,000 | 76,637 | 624 |
| small / hand-built stamp | 40,000 | 109,471 | 596 |
| medium / factory stamp | 12,000 | 40,401 | 1,978 |
| medium / hand-built stamp | 12,000 | 31,643 | 1,975 |
| deep / factory stamp | 4,000 | 31,944 | 3,039 |
| deep / hand-built stamp | 4,000 | 26,549 | 3,040 |

The optimization removes the material medium/deep penalty without changing the
retained event graph. The small factory case remains slower because creating a
separate immutable stamp has fixed overhead that dominates a tiny payload. At
roughly 77,000 complete records per second on this machine, that case does not
justify a second special path. Consumers should rerun the benchmark on their
deployment runtime before treating these absolute numbers as capacity limits.
