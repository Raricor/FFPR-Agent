/**
 * The LAN link to the game's bridge plugin (control plan §5), ported from ffpr_agent/bridge.py:
 * HTTP health checks, one kept-open /v1/query WebSocket, one /v1/command WebSocket for key
 * commands, and /v1/stream for every record the bridge writes. The token stays inside this module
 * and never enters an error message.
 */

import { readEnvFile } from "./env.ts";
import { describeError } from "./errors.ts";
import { AsyncLock } from "./lock.ts";

const DEFAULT_PORT = 47800;
const CONNECT_TIMEOUT_MS = 2000;
const QUERY_TIMEOUT_MS = 5000;

export interface BridgeLoadOptions {
  /** secrets.env holding BRIDGE_TOKEN; absent or empty means no link. */
  secretsFile: string;
  /** laptop.env holding BRIDGE_URL and LAPTOP_HOST. */
  laptopEnv: string;
  /** Explicit address; the spike uses it for a fake bridge. */
  url?: string;
  /** The port this game's bridge listens on (task 21: FF5 47800, FFN 4780N). */
  port?: number;
  /** Whether laptop.env's BRIDGE_URL applies; it names FF5's port, so only FF5 reads it. */
  laptopUrl?: boolean;
  signal?: AbortSignal;
}

export class LinkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LinkError";
  }
}

export type QueryFields = Record<string, unknown>;

interface SocketWaiter {
  resolve(text: string): void;
  reject(error: Error): void;
}

interface SocketState {
  readonly ws: WebSocket;
  /** Messages are buffered, so two replies arriving back to back cannot lose the second one. */
  readonly messages: string[];
  readonly waiters: SocketWaiter[];
  failure: Error | undefined;
  closed: boolean;
}

export class BridgeLink {
  readonly url: string;
  private readonly token: string;
  private readonly lock = new AsyncLock();
  /** One kept-open socket per path, so command and query never share a request stream. */
  private readonly sockets = new Map<string, SocketState>();
  private nextId = 1;

  constructor(url: string, token: string) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
  }

  /**
   * Build a link from the two config files. The explicit URL wins, then (FF5 only) BRIDGE_URL,
   * then LAPTOP_HOST with this game's port. Without BRIDGE_TOKEN there is no link and callers
   * skip the bridge.
   */
  static async load(options: BridgeLoadOptions): Promise<BridgeLink | undefined> {
    const secrets = await readEnvFile(options.secretsFile, options.signal);
    const token = secrets.BRIDGE_TOKEN;
    if (!token) return undefined;
    const explicit = options.url?.trim();
    if (explicit) return new BridgeLink(explicit, token);
    const laptop = await readEnvFile(options.laptopEnv, options.signal);
    const configured = options.laptopUrl === false ? undefined : laptop.BRIDGE_URL?.trim();
    if (configured) return new BridgeLink(configured, token);
    const host = laptop.LAPTOP_HOST?.trim();
    if (!host) {
      throw new Error(`laptop.env 里缺少 LAPTOP_HOST,也没有配置 BRIDGE_URL:${options.laptopEnv}`);
    }
    return new BridgeLink(`http://${host}:${options.port ?? DEFAULT_PORT}`, token);
  }

  /** One /v1/query round trip; reconnects once when the socket drops or times out. */
  async query(op: string, fields: QueryFields, signal: AbortSignal): Promise<unknown> {
    return this.ask("/v1/query", op, fields, signal, QUERY_TIMEOUT_MS);
  }

  /** One key command (keys, status, stop); returns when the bridge has finished it. */
  async command(
    op: string,
    fields: QueryFields,
    signal: AbortSignal,
    timeoutMs: number = QUERY_TIMEOUT_MS,
  ): Promise<unknown> {
    return this.ask("/v1/command", op, fields, signal, timeoutMs);
  }

  /**
   * Every record the bridge writes from now on, the hello record first, until the caller stops.
   * The socket closes when the loop breaks or the signal aborts.
   */
  async *stream(signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
    const path = "/v1/stream";
    const url = this.wsUrl(path);
    let state: SocketState;
    try {
      state = createSocketState(
        new WebSocket(url, { headers: { Authorization: `Bearer ${this.token}` } }),
      );
    } catch (error) {
      throw new LinkError(`连不上 ${url}:${describeError(error)}`, { cause: error });
    }
    try {
      try {
        await waitForOpen(state.ws, CONNECT_TIMEOUT_MS, signal);
      } catch (error) {
        signal.throwIfAborted();
        throw new LinkError(`连不上 ${url}:${describeError(error)}`, { cause: error });
      }
      for (;;) {
        // No per-message timeout: records arrive as the game writes them.
        yield parseRecord(await receive(state, undefined, signal));
      }
    } finally {
      closeState(state);
    }
  }

  close(): void {
    for (const path of [...this.sockets.keys()]) this.closeSocket(path);
  }

  /**
   * GET /v1/health, allowing 2 seconds for the connection; any status but 200 is a LinkError.
   * Deliberately outside the query lock: a long `story` command must not delay the pre-step
   * health check, and health is just one idempotent HTTP request.
   */
  async health(signal: AbortSignal): Promise<unknown> {
    const url = `${this.url}/v1/health`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]),
      });
    } catch (error) {
      signal.throwIfAborted();
      throw new LinkError(`连不上 ${url}:${describeError(error)}`, { cause: error });
    }
    if (response.status !== 200) throw new LinkError(`/v1/health 返回 ${response.status}`);
    try {
      const body: unknown = await response.json();
      return body;
    } catch (error) {
      throw new LinkError(`读不懂 /v1/health 的回复:${describeError(error)}`, { cause: error });
    }
  }

  /**
   * One request/reply round trip on a kept-open socket. Query and command share the lock: the
   * bridge has one game, so a key command must not interleave with a state read.
   */
  private async ask(
    path: string,
    op: string,
    fields: QueryFields,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<unknown> {
    return this.lock.run(async () => {
      let failure: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await this.askOnce(path, op, fields, signal, timeoutMs);
        } catch (error) {
          this.closeSocket(path);
          signal.throwIfAborted();
          failure = error;
        }
      }
      throw new LinkError(`${path} ${op} 失败:${describeError(failure)}`, { cause: failure });
    });
  }

  private async askOnce(
    path: string,
    op: string,
    fields: QueryFields,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<unknown> {
    const socket = await this.ensureSocket(path, signal);
    const id = this.nextId;
    this.nextId += 1;
    socket.ws.send(JSON.stringify({ id, op, ...fields }));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`等回复超时(${timeoutMs}ms)`);
      const text = await receive(socket, remaining, signal);
      const reply = parseReply(text);
      // Replies to earlier, timed-out requests may still arrive; skip them.
      if (reply.type === "reply" && reply.re === id) return reply;
    }
  }

  private async ensureSocket(path: string, signal: AbortSignal): Promise<SocketState> {
    const existing = this.sockets.get(path);
    if (existing && !existing.closed && existing.ws.readyState === WebSocket.OPEN) {
      return existing;
    }
    this.closeSocket(path);
    const url = this.wsUrl(path);
    let state: SocketState;
    try {
      state = createSocketState(
        new WebSocket(url, { headers: { Authorization: `Bearer ${this.token}` } }),
      );
    } catch (error) {
      throw new LinkError(`连不上 ${url}:${describeError(error)}`, { cause: error });
    }
    this.sockets.set(path, state);
    try {
      await waitForOpen(state.ws, CONNECT_TIMEOUT_MS, signal);
      // The bridge sends a hello record first; read it before the first request/reply pair.
      await receive(state, CONNECT_TIMEOUT_MS, signal);
    } catch (error) {
      this.closeSocket(path);
      signal.throwIfAborted();
      throw new LinkError(`连不上 ${url}:${describeError(error)}`, { cause: error });
    }
    return state;
  }

  private wsUrl(path: string): string {
    return `${this.url.replace(/^http/, "ws")}${path}`;
  }

  private closeSocket(path: string): void {
    const socket = this.sockets.get(path);
    this.sockets.delete(path);
    if (socket) closeState(socket);
  }
}

function closeState(socket: SocketState): void {
  try {
    socket.ws.close();
  } catch {
    // Closing a socket that already failed is harmless; the close listener records the failure.
  }
}

function createSocketState(ws: WebSocket): SocketState {
  const state: SocketState = {
    ws,
    messages: [],
    waiters: [],
    failure: undefined,
    closed: false,
  };
  ws.addEventListener("message", (event) => {
    try {
      deliver(state, messageText(event.data));
    } catch (error) {
      fail(state, asError(error));
    }
  });
  ws.addEventListener("error", () => {
    fail(state, new Error("连接出错"));
  });
  ws.addEventListener("close", (event) => {
    fail(state, new Error(`连接断开(code ${event.code})`));
  });
  return state;
}

function deliver(state: SocketState, text: string): void {
  if (state.failure) return;
  const waiter = state.waiters.shift();
  if (waiter) waiter.resolve(text);
  else state.messages.push(text);
}

function fail(state: SocketState, error: Error): void {
  if (state.closed) return;
  state.closed = true;
  state.failure = error;
  for (const waiter of state.waiters.splice(0)) waiter.reject(error);
}

function receive(
  state: SocketState,
  timeoutMs: number | undefined,
  signal: AbortSignal,
): Promise<string> {
  if (state.messages.length > 0) {
    const [text] = state.messages.splice(0, 1);
    if (text !== undefined) return Promise.resolve(text);
  }
  if (state.failure) return Promise.reject(state.failure);
  return new Promise<string>((resolve, reject) => {
    const waiter: SocketWaiter = {
      resolve: (text) => {
        cleanup();
        resolve(text);
      },
      reject: (error) => {
        cleanup();
        reject(error);
      },
    };
    function cleanup(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const index = state.waiters.indexOf(waiter);
      if (index >= 0) state.waiters.splice(index, 1);
    }
    const onAbort = (): void => {
      waiter.reject(abortError());
    };
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            cleanup();
            reject(new Error(`等回复超时(${timeoutMs}ms)`));
          }, timeoutMs);
    state.waiters.push(waiter);
    if (signal.aborted) {
      waiter.reject(abortError());
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForOpen(socket: WebSocket, timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`连接超时(${timeoutMs}ms)`));
    }, timeoutMs);
    const cleanup = (): void => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("连接出错"));
    };
    const onClose = (event: CloseEvent): void => {
      cleanup();
      reject(new Error(`连接断开(code ${event.code})`));
    };
    const onAbort = (): void => {
      cleanup();
      reject(abortError());
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function messageText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  throw new Error("桥插件发来二进制消息,读不懂");
}

function parseReply(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("桥插件的回复不是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

function parseRecord(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("桥插件发来的记录不是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

function abortError(): DOMException {
  return new DOMException("操作已取消", "AbortError");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
