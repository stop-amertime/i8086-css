// mcp-client.mjs — tiny MCP (Model Context Protocol) client over a
// framed bytes transport.
//
// MCP is JSON-RPC 2.0. calcite-debugger's implementation uses
// newline-delimited JSON (NDJSON) — no Content-Length framing.
//
// Two supported transports:
//   - child: spawn `calcite-debugger.exe [opts...]` and talk over stdio.
//     State dies with the child process; fine for one-shot test runs.
//   - tcp:   connect to an already-running daemon (`--listen HOST:PORT`).
//     State survives across multiple client connections, so reuse across
//     pipeline invocations is possible. MCP framing over TCP is also NDJSON.
//
// Public shape: `await client.call('tick', {session: 's', count: 10})`
// returns the parsed tool result object. Errors (MCP-level or wall-clock
// timeout) throw.

import { spawn } from 'node:child_process';
import net from 'node:net';

export class McpError extends Error {
  constructor(message, { code, data, cause } = {}) {
    super(message);
    this.name = 'McpError';
    this.code = code ?? null;
    this.data = data ?? null;
    if (cause) this.cause = cause;
  }
}

class LineBuffer {
  constructor() { this.buf = ''; }
  push(chunk) {
    this.buf += chunk;
    const lines = [];
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      lines.push(this.buf.slice(0, idx).trim());
      this.buf = this.buf.slice(idx + 1);
    }
    return lines;
  }
}

class Base {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();              // id → {resolve, reject, timer}
    this.ready = false;
    this.readyPromise = null;
    this._closeError = null;
  }

  _onLine(line) {
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); }
    catch (err) { return; /* ignore non-JSON (daemon prints banners on stdout/stderr) */ }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new McpError(msg.error.message ?? 'MCP error', { code: msg.error.code, data: msg.error.data }));
      } else {
        p.resolve(msg.result);
      }
    }
    // Notifications (no id) — currently ignored. We don't subscribe to
    // anything that matters for test automation.
  }

  _onClose(err) {
    this._closeError = err ?? new Error('MCP transport closed');
    for (const { reject, timer } of this.pending.values()) {
      if (timer) clearTimeout(timer);
      reject(this._closeError);
    }
    this.pending.clear();
  }

  async _send(msg, { timeoutMs = 60_000 } = {}) {
    if (this._closeError) throw this._closeError;
    const id = msg.id;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`MCP request id=${id} method=${msg.method} timed out after ${timeoutMs}ms`));
      }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer });
      this._write(JSON.stringify(msg) + '\n');
    });
  }

  async initialize({ timeoutMs = 10_000 } = {}) {
    if (this.ready) return;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      const id = this.nextId++;
      await this._send({
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'css-dos-harness', version: '0.1' },
        },
      }, { timeoutMs });
      // Required followup per the spec — without this the server keeps
      // some clients in "waiting for initialized" mode. Harmless to send.
      this._write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      this.ready = true;
    })();
    return this.readyPromise;
  }

  // MCP `tools/call`: name + arguments. Returns the tool's content.
  // calcite-debugger's tools all return a single structured JSON result
  // inside `result.content[0].text` or `result.structuredContent`
  // depending on rmcp version — we handle both.
  async call(toolName, args, { timeoutMs = 60_000 } = {}) {
    await this.initialize();
    const id = this.nextId++;
    const result = await this._send({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: toolName, arguments: args ?? {} },
    }, { timeoutMs });
    if (result?.isError) {
      const txt = result?.content?.[0]?.text ?? JSON.stringify(result);
      throw new McpError(`tool ${toolName} failed: ${txt}`);
    }
    if (result?.structuredContent !== undefined) return result.structuredContent;
    // Fallback: single text content that holds JSON.
    const content = result?.content;
    if (Array.isArray(content) && content.length === 1 && content[0].type === 'text') {
      try { return JSON.parse(content[0].text); }
      catch { return { text: content[0].text }; }
    }
    return result;
  }

  async listTools({ timeoutMs = 10_000 } = {}) {
    await this.initialize();
    const id = this.nextId++;
    return this._send({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }, { timeoutMs });
  }

  async close() { /* overridden by subclass */ }
}

export class ChildMcpClient extends Base {
  constructor(binPath, argv, { env } = {}) {
    super();
    this.child = spawn(binPath, argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(env ?? {}) },
    });
    const stdoutBuf = new LineBuffer();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      for (const line of stdoutBuf.push(chunk)) this._onLine(line);
    });
    this.stderrLines = [];
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => {
      this.stderrLines.push(chunk);
      // keep bounded — stderr from a 1hr debugger run can be huge
      if (this.stderrLines.length > 500) this.stderrLines.splice(0, this.stderrLines.length - 500);
    });
    this.child.on('close', (code, sig) => {
      this._onClose(new McpError(`calcite-debugger exited: code=${code} signal=${sig}\nstderr: ${this.stderrLines.join('').slice(-2000)}`));
    });
    this.child.on('error', err => this._onClose(err));
  }

  _write(line) { this.child.stdin.write(line); }

  async close({ killTimeoutMs = 2000 } = {}) {
    if (!this.child || this.child.killed) return;
    try { this.child.stdin.end(); } catch { /* ignore */ }
    await new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { this.child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve();
      }, killTimeoutMs);
      this.child.once('close', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export class TcpMcpClient extends Base {
  constructor({ host = '127.0.0.1', port }) {
    super();
    this.sock = net.createConnection({ host, port });
    const buf = new LineBuffer();
    this.sock.setEncoding('utf8');
    this.sock.on('data', chunk => {
      for (const line of buf.push(chunk)) this._onLine(line);
    });
    this.sock.on('close', () => this._onClose(new McpError(`MCP TCP connection to ${host}:${port} closed`)));
    this.sock.on('error', err => this._onClose(err));
  }
  _write(line) { this.sock.write(line); }
  async close() {
    try { this.sock.end(); } catch { /* ignore */ }
  }
}

// Convenience: spawn a child for a specific cabinet and return a
// connected + initialised client with an `open`'d session.
export async function openChild({ binPath, cssPath, session = 'harness', argv = [], initTimeoutMs = 30_000 }) {
  const args = [];
  if (cssPath) {
    args.push('-i', cssPath);
    args.push('--session', session);
  }
  args.push(...argv);
  const client = new ChildMcpClient(binPath, args);
  await client.initialize({ timeoutMs: initTimeoutMs });
  return { client, session };
}
