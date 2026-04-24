// debugger-client.mjs — harness-facing client for calcite-debugger.
//
// This is a thin adapter over mcp-client.mjs that maps from the HTTP-style
// method names used elsewhere in the harness (`dbg.tick(n)`, `dbg.memory(addr, len)`)
// onto MCP tool calls.
//
// Two factory methods:
//
//   spawnChild({ cssPath, session })
//     Fresh child process, self-contained. Dies when you `.close()`.
//     Use this for one-shot test runs so the harness never leaves an orphan
//     daemon lying around.
//
//   connectTcp({ host, port, session })
//     Connect to the user's pre-running daemon (e.g. the one their MCP
//     client keeps resident across Claude Code sessions). Caller is
//     responsible for first calling `open` if the session doesn't exist.
//
// All methods take/include `session` — every calcite-debugger tool requires
// it. Constructor binds a default session so the harness doesn't have to
// thread it through every call site.

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChildMcpClient, TcpMcpClient } from './mcp-client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Locate the debugger binary. Overridable for CI or unusual layouts.
export function defaultDebuggerBinary() {
  const envPath = process.env.CALCITE_DEBUGGER_BIN;
  if (envPath) return envPath;
  const siblingCalcite = resolve(__dirname, '..', '..', '..', '..', 'calcite', 'target', 'release', 'calcite-debugger.exe');
  return siblingCalcite;
}

export class DebuggerClient {
  constructor({ mcp, session, ownsChild = false }) {
    this.mcp = mcp;
    this.session = session;
    this.ownsChild = ownsChild;
  }

  static async spawnChild({ binPath, cssPath, session = 'harness', initTimeoutMs = 60_000, extraArgs = [] } = {}) {
    const actualBin = binPath ?? defaultDebuggerBinary();
    const args = [];
    if (cssPath) {
      args.push('-i', cssPath, '--session', session);
    }
    args.push(...extraArgs);
    const mcp = new ChildMcpClient(actualBin, args);
    // Parse+compile can take 5-30s for big cabinets. Give initialize a
    // wide timeout because the server accepts `initialize` right away,
    // but tool calls will block until compile finishes.
    await mcp.initialize({ timeoutMs: initTimeoutMs });
    return new DebuggerClient({ mcp, session, ownsChild: true });
  }

  static async connectTcp({ host = '127.0.0.1', port, session = 'harness', initTimeoutMs = 10_000 } = {}) {
    if (port == null) throw new Error('connectTcp requires { port }');
    const mcp = new TcpMcpClient({ host, port });
    await mcp.initialize({ timeoutMs: initTimeoutMs });
    return new DebuggerClient({ mcp, session, ownsChild: false });
  }

  async close() {
    if (this.ownsChild) await this.mcp.close();
  }

  // ---- tool wrappers, accepting flat args and folding in `session` ----

  // Some tools are session-less (none at time of writing; every tool
  // takes a session).
  _withSession(extra) { return { ...extra, session: this.session }; }

  async call(tool, args = {}, opts) {
    return this.mcp.call(tool, this._withSession(args), opts);
  }

  // Liveness. Cheap — `info` works even without a loaded program.
  async ping({ timeoutMs = 2_000 } = {}) {
    try {
      await this.mcp.call('info', { session: this.session }, { timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  info()                                { return this.call('info'); }
  state()                               { return this.call('get_state'); }
  tick(count = 1)                       { return this.call('tick', { count }, { timeoutMs: Math.max(30_000, count * 2) }); }
  seek(tick)                            { return this.call('seek', { tick }, { timeoutMs: 300_000 }); }
  memory(addr, len = 256)               { return this.call('read_memory', { addr, len }); }
  screen(opts = {})                     { return this.call('render_screen', opts); }
  comparePaths()                        { return this.call('compare_paths'); }
  compareState(registers, memory = [])  { return this.call('compare_state', { registers, memory }); }
  key(value, target = 'bda')            { return this.call('send_key', { value, target }); }
  snapshot()                            { return this.call('snapshots', { action: 'create' }); }
  snapshotList()                        { return this.call('snapshots', { action: 'list' }); }
  open(path, session)                   { return this.call('open', { path, session: session ?? this.session }); }
  closeSession()                        { return this.call('close_session', {}); }
  entryStateCheck(opts = {})            { return this.call('entry_state_check', opts, { timeoutMs: 600_000 }); }

  // Convenience: pass-through for anything not yet wrapped.
  // Matches the old request(path, {body, method}) interface.
  // Callers using the old API will be auto-migrated through tool name
  // mapping below.
  request(path, { method = 'GET', body = null, timeoutMs = 30_000 } = {}) {
    const spec = HTTP_TO_TOOL[path];
    if (!spec) throw new Error(`debugger-client: no tool mapping for ${method} ${path} — add to HTTP_TO_TOOL or call tool directly`);
    return this.call(spec.tool, spec.map ? spec.map(body) : body, { timeoutMs });
  }

  // run_until with job polling. Returns whatever the server returns.
  // Harness code should prefer timed-run.mjs's chunked /tick driving
  // — this is just a pass-through if the caller wants native run_until.
  async runUntil(condition, { maxTicks = 1_000_000, fromTick = null } = {}) {
    const body = { condition, max_ticks: maxTicks };
    if (fromTick != null) body.from_tick = fromTick;
    return this.call('run_until', body, { timeoutMs: Math.max(60_000, maxTicks / 100) });
  }

  // Watchpoint — blocks until hit or max_ticks. Passthrough.
  watchpoint({ addr, maxTicks = 200_000, fromTick = null, expected = null }) {
    const body = { addr, max_ticks: maxTicks };
    if (fromTick != null) body.from_tick = fromTick;
    if (expected != null) body.expected = expected;
    return this.call('watchpoint', body, { timeoutMs: Math.max(60_000, maxTicks / 50) });
  }
}

// HTTP-path → MCP-tool name. Keeps compatibility with anywhere in the
// harness that still uses `.request(path)`. The mapping is only for
// paths we actually hit.
const HTTP_TO_TOOL = {
  '/info':           { tool: 'info' },
  '/state':          { tool: 'get_state' },
  '/tick':           { tool: 'tick' },
  '/seek':           { tool: 'seek' },
  '/memory':         { tool: 'read_memory' },
  '/screen':         { tool: 'render_screen' },
  '/compare-paths':  { tool: 'compare_paths' },
};
