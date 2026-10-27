/**
 * A local stand-in for the game's bridge plugin, used by tests only (never a real laptop).
 * It serves /v1/health, /v1/query, /v1/command and /v1/stream with the same Bearer check and
 * hello-then-reply shape.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";

export interface ReceivedQuery {
  readonly request: Record<string, unknown>;
  readonly receivedAt: number;
  repliedAt?: number;
}

type ReplyFactory = (request: Record<string, unknown>) => unknown;

export class FakeBridge {
  readonly token: string;
  readonly queries: ReceivedQuery[] = [];
  readonly commands: ReceivedQuery[] = [];
  healthCalls = 0;
  streamConnections = 0;
  activeStreams = 0;

  private server: Server | undefined;
  private wss: WebSocketServer | undefined;
  private readonly sockets = new Set<WebSocket>();
  private replyFactory: ReplyFactory | undefined;
  private commandFactory: ReplyFactory | undefined;
  private streamRecords: readonly unknown[] | undefined;
  private endStreamAfterRecords = false;
  private extraWrongReply = false;
  private dropQueries = 0;
  private dropCommands = 0;
  private delayMs = 0;
  private nextPort = 0;
  private running = false;

  constructor(token = "test-token") {
    this.token = token;
  }

  get url(): string {
    if (!this.running) throw new Error("fake bridge 还没启动");
    return `http://127.0.0.1:${this.nextPort}`;
  }

  async start(): Promise<void> {
    if (this.running) throw new Error("fake bridge 已经启动");
    const server = createServer((request, response) => {
      this.handleHttp(request, response);
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      if (!this.authorized(request)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (client) => {
        wss.emit("connection", client, request);
      });
    });
    wss.on("connection", (client: WebSocket, request: IncomingMessage) => {
      this.sockets.add(client);
      client.on("close", () => {
        this.sockets.delete(client);
        if (request.url === "/v1/stream") this.activeStreams = Math.max(0, this.activeStreams - 1);
      });
      client.send(JSON.stringify({ type: "hello" }));
      if (request.url === "/v1/stream") {
        this.startStream(client);
        return;
      }
      client.on("message", (data) => {
        void this.handleRequest(client, request.url ?? "", rawText(data)).catch(() => {
          // The fake only needs to fail the client call; the test asserts that failure.
          client.terminate();
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.nextPort, "127.0.0.1");
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("fake bridge 没拿到端口");
    }
    this.server = server;
    this.wss = wss;
    this.nextPort = address.port;
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    for (const client of this.sockets) client.terminate();
    this.sockets.clear();
    this.activeStreams = 0;
    const wss = this.wss;
    this.wss = undefined;
    if (wss) {
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
      });
    }
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }

  setReply(reply: unknown): void {
    this.replyFactory = () => reply;
  }

  setReplyFactory(factory: ReplyFactory): void {
    this.replyFactory = factory;
  }

  setCommandReply(reply: unknown): void {
    this.commandFactory = () => reply;
  }

  setCommandReplyFactory(factory: ReplyFactory): void {
    this.commandFactory = factory;
  }

  /** Send a reply for a different request id before every real reply. */
  setExtraWrongReply(enabled: boolean): void {
    this.extraWrongReply = enabled;
  }

  /** Drop the next `count` query connections without replying (a reconnect). */
  dropNextQueries(count: number): void {
    this.dropQueries = count;
  }

  dropNextCommands(count: number): void {
    this.dropCommands = count;
  }

  /** Wait before replying, so tests can observe whether calls are serialized. */
  setReplyDelay(delayMs: number): void {
    this.delayMs = delayMs;
  }

  /** Records sent on every new /v1/stream socket, after the hello record. */
  setStreamRecords(records: readonly unknown[], end = false): void {
    this.streamRecords = records;
    this.endStreamAfterRecords = end;
  }

  /** Close every open socket, as a game restart would. */
  disconnectSockets(): void {
    for (const client of this.sockets) client.terminate();
    this.sockets.clear();
    this.activeStreams = 0;
  }

  private startStream(client: WebSocket): void {
    this.streamConnections += 1;
    this.activeStreams += 1;
    for (const record of this.streamRecords ?? []) client.send(JSON.stringify(record));
    if (this.endStreamAfterRecords) client.close(1000);
  }

  private handleHttp(request: IncomingMessage, response: ServerResponse): void {
    if (request.method === "GET" && request.url === "/v1/health") {
      this.healthCalls += 1;
      if (!this.authorized(request)) {
        this.sendJson(response, 401, { ok: false });
        return;
      }
      this.sendJson(response, 200, { ok: true });
      return;
    }
    this.sendJson(response, 404, { ok: false });
  }

  private authorized(request: IncomingMessage): boolean {
    return request.headers.authorization === `Bearer ${this.token}`;
  }

  private sendJson(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  }

  private async handleRequest(client: WebSocket, path: string, raw: string): Promise<void> {
    if (path !== "/v1/query" && path !== "/v1/command") {
      client.close(1008, "unknown path");
      return;
    }
    let request: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        client.close(1003, "not an object");
        return;
      }
      request = parsed as Record<string, unknown>;
    } catch {
      client.close(1003, "not json");
      return;
    }
    const entry: ReceivedQuery = { request, receivedAt: Date.now() };
    const isCommand = path === "/v1/command";
    if (isCommand) this.commands.push(entry);
    else this.queries.push(entry);
    if (isCommand && this.dropCommands > 0) {
      this.dropCommands -= 1;
      client.terminate();
      return;
    }
    if (!isCommand && this.dropQueries > 0) {
      this.dropQueries -= 1;
      client.terminate();
      return;
    }
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (client.readyState !== WebSocket.OPEN) return;
    if (this.extraWrongReply) {
      client.send(JSON.stringify({ type: "reply", re: -1, op: request.op, ok: true }));
    }
    const factory = isCommand ? this.commandFactory : this.replyFactory;
    const reply = factory
      ? factory(request)
      : { type: "reply", re: request.id, op: request.op, ok: true };
    client.send(JSON.stringify(reply));
    entry.repliedAt = Date.now();
  }
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return new TextDecoder().decode(data);
}
