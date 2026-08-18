# Domain-event recording benchmark

This benchmark measures the complete in-memory path from an aggregate decision
to a recorded event:

1. Create and freeze an `UncommittedDomainEvent`.
2. Create a factory-owned or hand-built `DomainEventStamp`.
3. Record the final `DomainEvent`.

Run it with:

```bash
pnpm benchmark:event-stamping
```

The command builds the package and runs
`benchmarks/domain-event-stamping.mjs` with `--expose-gc`. Each case warms the
runtime first. Throughput includes transient cloning and freezing work.
Retained bytes are the heap delta after forced garbage collection. Every final
event remains reachable during this measurement. Use this value to compare the
final graph size, not temporary allocations.

## Optimization threshold

The factory path is the normal production path. If duplicate defensive copies
make this path at least 15% slower, add internal ownership logic. Use the medium
or deeply nested case for this comparison. A smaller difference can result from
runtime noise and does not justify more lifecycle logic.

The initial measurement crossed the threshold. Factory stamps performed about
22% fewer operations per second for medium data. They performed 28% fewer
operations for deeply nested data. The factory copied and froze its metadata.
Final recording then copied the owned metadata and decision payload a second
time.

Factory-created stamps now carry a non-enumerable internal ownership brand.
Recording can share their already immutable metadata and the decision's already
immutable payload. A hand-built stamp also shares the decision payload. Only its own fields, the
time and the metadata, take the defensive-copy path.
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
justify a second special path. Run the benchmark on the deployment runtime
before you use these numbers as capacity limits.
