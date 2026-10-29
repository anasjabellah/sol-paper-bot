/**
 * Minimal local WebSocket server for tests (RFC 6455 handshake, unfragmented text frames, ping/pong,
 * close). Binds 127.0.0.1 on a random port. Stands in for Helius so real Node WebSocket behaviour
 * can be exercised without any external network access.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class LocalWsServer {
  private readonly server = createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"local test server"}');
  });
  private sockets: Duplex[] = [];
  readonly received: string[] = [];
  connections = 0;
  /** Handles each text message; `reply` sends a JSON text frame on the same connection. */
  onMessage: (msg: { id?: number; method?: string; params?: unknown[] }, reply: (o: unknown) => void) => void = () => {};

  async start(): Promise<number> {
    this.server.on('upgrade', (req: IncomingMessage, socket: Duplex) => this.upgrade(req, socket));
    await new Promise<void>((ok) => this.server.listen(0, '127.0.0.1', ok));
    return (this.server.address() as AddressInfo).port;
  }

  /** Sends a JSON message on every open connection. */
  broadcast(o: unknown): void {
    for (const s of this.sockets) s.write(encodeFrame(Buffer.from(JSON.stringify(o)), 1));
  }

  /** Abruptly drops every connection (no close frame), like a network failure. */
  dropAll(): void {
    for (const s of this.sockets) s.destroy();
    this.sockets = [];
  }

  async stop(): Promise<void> {
    this.dropAll();
    await new Promise<void>((ok) => this.server.close(() => ok()));
  }

  private upgrade(req: IncomingMessage, socket: Duplex): void {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') return void socket.destroy();
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    this.connections++;
    this.sockets.push(socket);
    let buf = Buffer.alloc(0);
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.sockets = this.sockets.filter((s) => s !== socket);
    });
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const f = parseFrame(buf);
        if (!f) break;
        buf = buf.subarray(f.length);
        if (f.opcode === 1) {
          const text = f.payload.toString('utf8');
          this.received.push(text);
          let msg: { id?: number; method?: string; params?: unknown[] } = {};
          try {
            msg = JSON.parse(text);
          } catch {
            // ignore
          }
          this.onMessage(msg, (o) => socket.write(encodeFrame(Buffer.from(JSON.stringify(o)), 1)));
        } else if (f.opcode === 9) {
          socket.write(encodeFrame(f.payload, 10)); // pong
        } else if (f.opcode === 8) {
          socket.end(encodeFrame(Buffer.alloc(0), 8));
        }
      }
    });
  }
}

function parseFrame(buf: Buffer): { opcode: number; payload: Buffer; length: number } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let len = buf[1]! & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  const maskAt = off;
  if (masked) off += 4;
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (masked) for (let i = 0; i < payload.length; i++) payload[i]! ^= buf[maskAt + (i % 4)]!;
  return { opcode, payload, length: off + len };
}

function encodeFrame(payload: Buffer, opcode: number): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}
