# Calcite Debugger Quick Reference

Full documentation: [`../../../calcite/docs/debugger.md`](../../../calcite/docs/debugger.md).

**For scripted work, prefer `calcite-cli` over the debugger daemon.**
The daemon is the right tool for interactive exploration ("what's
going on at tick X?") but its MCP surface is unreliable enough in
practice that batch / agentic workflows are better served by
calcite-cli + `--watch` ([`docs/script-primitives.md`](../script-primitives.md))
or the harness pipeline.

When you do drive the debugger, jump straight to
[Agent-oriented tooling](../../../calcite/docs/debugger.md#agent-oriented-tooling)
in the calcite docs — it lists the MCP tools added for agentic
debugging (`inspect_packed_cell`, `compare_paths`, `watchpoint`,
async `run_until`, multi-session side-by-side diffs) and the
workflow that goes with them. Harness wrappers for each tool live in
[`tests/harness/lib/debugger-client.mjs`](../../tests/harness/lib/debugger-client.mjs).

## Starting

```sh
cargo run --release -p calcite-debugger -- -i path/to/program.css
# Listens on port 3333 (change with -p PORT)
```

## Rebuilding after source edits

If `cargo build --release -p calcite-debugger` fails with
`Permission denied` on `deps\calcite_debugger-*.exe`, an orphaned
debugger (or your MCP client's resident instance) is holding the
binary open. From `../calcite`:

```sh
./kill-and-rebuild.bat
```

That kills all `calcite-debugger.exe` processes and rebuilds. MCP
clients respawn the debugger on the next tool call.

## Tools (MCP-first; HTTP still works)

The debugger speaks both MCP (stdio + TCP) and HTTP. Agents and the test
harness drive it via MCP through
[`tests/harness/lib/debugger-client.mjs`](../../tests/harness/lib/debugger-client.mjs);
the HTTP endpoints below are the same operations exposed for `curl`-style
exploration.

| MCP tool | HTTP endpoint | Description |
|----------|----------|-------------|
| `tick` | `POST /tick {"count":N}` | Advance N ticks |
| `seek` | `POST /seek {"tick":N}` | Jump to tick N (uses checkpoints) |
| `get_state` | `GET /state` | All registers + computed properties |
| `read_memory` | `POST /memory {"addr":N,"len":N}` | Hex dump of memory region |
| `render_screen` | `POST /screen` | Render VGA text buffer |
| `compare_paths` | `GET /compare-paths` | Diff compiled vs interpreted at current tick |
| `trace_property` | `POST /trace-property` | Trace compiled execution of a property |
| `dump_ops` | `POST /dump-ops` | Dump raw compiled ops in range |
| `send_key` | `POST /keyboard` | Set keyboard CSS property |
| `watchpoint` | — | Block until a memory address takes a value (or max_ticks) |
| `inspect_packed_cell` | — | Decode a packed memory cell |
| `run_until` | — | Async run-until-condition with tick ceiling. **No wall-clock cap** — see Budgets in [TESTING.md](../TESTING.md) |

## Typical workflow

Through the harness wrapper (preferred):

```sh
# Stop at the diverging tick and check compiled vs interpreted in one go.
node tests/harness/pipeline.mjs consistency <cabinet>.css --tick=3740
```

Direct over HTTP for ad-hoc exploration:

```sh
curl -X POST localhost:3333/seek -d '{"tick":3740}'
curl -s localhost:3333/compare-paths | python3 -m json.tool
curl -X POST localhost:3333/trace-property -d '{"property":"--memAddr"}'
curl -X POST localhost:3333/memory -d '{"addr":1024,"len":64}'
```

## When NOT to drive the debugger

For "what's on screen at tick N" against a fresh cabinet, the daemon path is
the wrong tool — it does ~1500 ticks/s and won't reach late ticks inside a
2-minute budget. Use `pipeline.mjs fast-shoot` (~375K ticks/s via
`calcite-cli`) instead. See [TESTING.md](../TESTING.md) and the harness
README for the budget rule.
