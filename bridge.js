const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const HTTP_PORT = Number(process.env.BRIDGE_PORT || 8080);
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || 6379);
const publicDir = path.join(__dirname, 'public');

function encode(args) {
  return `*${args.length}\r\n` + args.map(value => {
    const text = String(value);
    return `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
  }).join('');
}

function frameLength(buffer, offset = 0) {
  const end = buffer.indexOf('\r\n', offset);
  if (end < 0) return null;
  return { line: buffer.toString('utf8', offset, end), next: end + 2 };
}

function parseFrame(buffer, offset = 0) {
  if (offset >= buffer.length) return null;
  const kind = String.fromCharCode(buffer[offset]);
  const header = frameLength(buffer, offset + 1);
  if (!header) return null;
  const value = header.line;
  if (kind === '+' || kind === '-' || kind === ':') return { end: header.next, value, kind };
  if (kind === '$') {
    const length = Number(value);
    if (length === -1) return { end: header.next, value: null, kind };
    const end = header.next + length + 2;
    if (buffer.length < end) return null;
    return { end, value: buffer.toString('utf8', header.next, header.next + length), kind };
  }
  if (kind === '*') {
    const items = [];
    let cursor = header.next;
    for (let i = 0; i < Number(value); i++) {
      const item = parseFrame(buffer, cursor);
      if (!item) return null;
      items.push(item.value);
      cursor = item.end;
    }
    return { end: cursor, value: items, kind };
  }
  return { end: header.next, value: value, kind: '-' };
}

function decode(frame) {
  const parsed = parseFrame(frame);
  if (!parsed) return { value: null, kind: '?', display: 'Incomplete RESP response' };
  return {
    value: parsed.value,
    kind: parsed.kind,
    display: parsed.kind === '-' ? `(error) ${parsed.value}` : parsed.value === null ? '(nil)' : Array.isArray(parsed.value) ? parsed.value.join(', ') : String(parsed.value)
  };
}

class RedisConnection {
  constructor() { this.socket = null; this.buffer = Buffer.alloc(0); this.pending = []; }
  connect() {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: REDIS_HOST, port: REDIS_PORT });
      this.socket = socket;
      const onError = error => { this.socket = null; this.pending.splice(0).forEach(item => item.reject(error)); reject(error); };
      socket.once('connect', resolve);
      socket.once('error', onError);
      socket.on('data', chunk => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.pending.length) {
          const parsed = parseFrame(this.buffer);
          if (!parsed) break;
          const item = this.pending.shift();
          const raw = this.buffer.subarray(0, parsed.end);
          this.buffer = this.buffer.subarray(parsed.end);
          item.resolve({ raw, parsed: decode(raw) });
        }
      });
      socket.on('close', () => { this.socket = null; this.pending.splice(0).forEach(item => item.reject(new Error('Redis connection closed'))); });
    });
  }
  async command(args) {
    await this.connect();
    const raw = Buffer.from(encode(args));
    const started = process.hrtime.bigint();
    const result = await new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket.write(raw, error => { if (error) reject(error); });
    });
    const elapsedUs = Number(process.hrtime.bigint() - started) / 1000;
    return { args, request: raw.toString(), response: result.raw.toString(), parsed: result.parsed, elapsedUs };
  }
}

const server = http.createServer((req, res) => {
  const requested = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.normalize(path.join(publicDir, requested));
  if (!file.startsWith(publicDir)) return res.writeHead(403).end();
  fs.readFile(file, (error, data) => {
    if (error) return res.writeHead(404).end('Not found');
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
    res.writeHead(200, { 'Content-Type': type }); res.end(data);
  });
});
const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  const redis = new RedisConnection();
  const send = payload => ws.readyState === ws.OPEN && ws.send(JSON.stringify(payload));
  ws.on('message', async message => {
    try {
      const input = JSON.parse(message.toString());
      if (input.type === 'command') send({ type: 'result', ...(await redis.command(input.args)) });
      else if (input.type === 'batch') {
        const results = [];
        for (const args of input.commands) results.push(await redis.command(args));
        send({ type: 'batch-result', results });
      }
    } catch (error) { send({ type: 'error', message: error.message }); }
  });
});
server.listen(HTTP_PORT, () => console.log(`Redis console: http://localhost:${HTTP_PORT} -> ${REDIS_HOST}:${REDIS_PORT}`));