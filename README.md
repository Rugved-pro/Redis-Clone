# C++ Redis Clone and Real-Time Web Console

A small Redis-compatible in-memory database written in C++ with a browser-based operations console. The project demonstrates how a database server accepts raw TCP connections, parses the Redis Serialization Protocol (RESP), executes data structure commands, persists data to disk, and exposes live performance details through a WebSocket bridge.

## What This Project Does

The project has two related demonstrations:

1. **Redis-compatible C++ server**
   - Listens on TCP port `6379` by default.
   - Accepts inline commands and RESP array commands.
   - Stores strings, lists, and hashes in memory.
   - Supports expiration and TTL inspection.
   - Handles multiple TCP clients using one worker thread per client.
   - Loads and saves a simple text-based database dump in `dump.my_rdb`.

2. **Real-time browser console**
   - Runs at `http://localhost:8080`.
   - Sends commands from the browser to a Node.js WebSocket bridge.
   - The bridge converts command arguments to RESP and forwards them over a raw TCP socket to the C++ server.
   - Every displayed response, latency number, key, type, TTL, and benchmark result comes from the running C++ server. The frontend does not use mocked database responses.

## Architecture

```text
Browser SPA
    |
    | WebSocket JSON messages
    v
bridge.js (HTTP server + WebSocket server)
    |
    | RESP over raw TCP
    v
my_redis_server (C++ on 127.0.0.1:6379)
    |
    v
RedisDatabase singleton
    |
    +-- string store
    +-- list store
    +-- hash store
    +-- expiry map
    +-- dump.my_rdb persistence
```

Browsers cannot open arbitrary raw TCP sockets, so the bridge is required. It also keeps the frontend independent from the C++ server implementation: the browser speaks WebSocket JSON, while the bridge owns RESP encoding, TCP socket management, response framing, and error recovery.

## Repository Layout

```text
.
├── include/
│   ├── RedisCommandHandler.h   # Command handler interface
│   ├── RedisDatabase.h         # Database API and in-memory stores
│   └── RedisServer.h            # TCP server interface
├── src/
│   ├── main.cpp                 # Loads persistence and starts the server
│   ├── RedisCommandHandler.cpp  # RESP parsing and command dispatch
│   ├── RedisDatabase.cpp        # Storage, TTL, deletion, persistence
│   └── RedisServer.cpp          # TCP accept loop and client threads
├── public/
│   ├── index.html               # Console layout
│   ├── styles.css               # Dense dark operations UI
│   └── app.js                   # WebSocket state and interactions
├── bridge.js                    # WebSocket-to-RESP/TCP middleware
├── package.json                 # Node start script and ws dependency
├── package-lock.json            # Locked Node dependency versions
├── Makefile                     # Linux/macOS C++ build commands
├── test_all.sh                  # redis-cli command smoke test
├── Concepts,UseCases&Tests.md   # Protocol and command notes
├── dump.my_rdb                  # Persistent database dump, when present
└── README.md
```

## Requirements

- C++17 compiler with POSIX socket support.
- Node.js 18 or newer.
- npm.
- Optional: `redis-cli` for the shell test script.

### Windows note

The checked-in `my_redis_server` artifact is a Linux ELF binary. On Windows, run it through WSL, or rebuild it with a Windows-compatible C++ toolchain. WSL is convenient because it can run the existing binary while the bridge remains available through Windows `localhost`.

## Build the C++ Server

### Linux, macOS, or WSL

From the repository root:

```bash
make
```

Or compile directly:

```bash
g++ -std=c++17 -Wall -pthread -Iinclude src/*.cpp -o my_redis_server
```

Run on the default port:

```bash
./my_redis_server
```

Run on another port:

```bash
./my_redis_server 6380
```

The server loads `dump.my_rdb` on startup when the file is available. It also starts a background persistence thread that writes the dump periodically and writes it during graceful shutdown.

### Windows with WSL

From PowerShell in the repository root:

```powershell
wsl.exe -d Ubuntu -- bash -lc "cd '/mnt/c/Users/Rugved/Downloads/College stuff/Redis-Clone' && ./my_redis_server"
```

Leave that terminal running. The C++ server should report that it is listening on port `6379`.

## Start the Browser Console

In a second terminal, from the repository root:

```powershell
npm install
npm start
```

Open `http://localhost:8080`.

The bridge defaults to:

```text
Browser HTTP/WebSocket: 127.0.0.1:8080
C++ Redis TCP server:   127.0.0.1:6379
```

Override the endpoints with environment variables:

```powershell
$env:BRIDGE_PORT = "8081"
$env:REDIS_HOST = "127.0.0.1"
$env:REDIS_PORT = "6380"
npm start
```

If the C++ server is stopped, the console shows `BRIDGE OFFLINE` or `REDIS UNAVAILABLE` and displays the actual socket error, such as `ECONNREFUSED`. Restarting the C++ server allows new commands to reconnect.

## How the Code Works

### C++ server

`src/RedisServer.cpp` creates a TCP socket, binds it, listens on the configured port, and accepts clients. Each accepted client is handled in a separate `std::thread`. Incoming bytes are passed to `RedisCommandHandler` and the raw RESP response is written back to the same socket.

`src/RedisCommandHandler.cpp` supports RESP arrays such as:

```text
*3\r\n$3\r\nSET\r\n$5\r\nhello\r\n$5\r\nworld\r\n
```

It also supports whitespace-separated inline commands for simple clients. The handler dispatches commands to the `RedisDatabase` singleton and formats results as RESP simple strings, integers, bulk strings, arrays, or errors.

`src/RedisDatabase.cpp` maintains separate containers for strings, lists, and hashes. A mutex protects database access. Expiration timestamps are held in an expiry map and expired keys are lazily removed when database operations inspect state.

### Node bridge

`bridge.js` does four jobs:

1. Serves the files in `public/` over HTTP.
2. Accepts browser WebSocket connections.
3. Encodes command arrays as RESP and sends them through Node's `net` socket API.
4. Parses complete RESP frames and returns the raw request, raw response, parsed value, response kind, and microsecond timing to the browser.

The bridge maintains one persistent C++ TCP connection per browser WebSocket client. Its parser handles simple strings, errors, integers, bulk strings, nil bulk strings, and arrays. It waits for complete RESP frames, so fragmented TCP packets are handled correctly.

### Browser console

The frontend is plain HTML, CSS, and JavaScript. It has no build step. The application keeps WebSocket connection state, command history, the latest wire exchange, inspector state, and benchmark metrics in the browser.

The visual design is intentionally compact and technical: dark zinc surfaces, sharp borders, restrained green success states, amber TTL warnings, and monospaced command/data areas.

## Supported Commands

### Common commands

| Command | Example | Result |
| --- | --- | --- |
| `PING` | `PING` | `PONG` |
| `ECHO` | `ECHO hello` | Echoed value |
| `FLUSHALL` | `FLUSHALL` | Clears all stores |

### String and key commands

| Command | Example | Result |
| --- | --- | --- |
| `SET` | `SET user:1 Alice` | Stores a string |
| `GET` | `GET user:1` | Reads a string or nil |
| `KEYS` | `KEYS *` | Returns active keys |
| `TYPE` | `TYPE user:1` | Returns `string`, `list`, `hash`, or `none` |
| `DEL` | `DEL user:1` | Deletes a key and returns an integer |
| `UNLINK` | `UNLINK user:1` | Uses the same delete handler |
| `EXPIRE` | `EXPIRE user:1 30` | Applies a TTL in seconds |
| `TTL` | `TTL user:1` | Returns remaining seconds, `-1`, or `-2` |
| `RENAME` | `RENAME user:1 user:2` | Renames a key |

`TTL` follows the usual Redis meanings: `-1` means the key exists without an expiration, and `-2` means the key does not exist.

### List commands

```text
LPUSH key value [value ...]
RPUSH key value [value ...]
LGET key
LLEN key
LPOP key
RPOP key
LREM key count value
LINDEX key index
LSET key index value
```

### Hash commands

```text
HSET key field value
HGET key field
HEXISTS key field
HDEL key field
HLEN key
HKEYS key
HVALS key
HGETALL key
HMSET key field value [field value ...]
```

## Demonstration Walkthrough

### 1. Verify the connection

Enter this in the **Command runner**:

```text
PING
```

The terminal shows `PONG` and the round-trip time. The top-right status should show `CONNECTED`.

### 2. Demonstrate strings and TTL

```text
SET session:demo active
GET session:demo
TYPE session:demo
EXPIRE session:demo 30
TTL session:demo
```

Click the refresh icon in **Key inspector**. The table sends `KEYS *`, then `TYPE` and `TTL` for each returned key. Expiring keys display a live countdown style with an amber warning when the remaining time is low.

### 3. Demonstrate lists

```text
RPUSH jobs build test deploy
LGET jobs
LPUSH jobs lint
RPOP jobs
LLEN jobs
```

This shows that the server stores ordered collections separately from strings.

### 4. Demonstrate hashes

```text
HSET user:1 name Rugved
HSET user:1 role developer
HGETALL user:1
TYPE user:1
```

The `TYPE` response proves that `user:1` is held in the hash store rather than the string store.

### 5. Demonstrate raw RESP

Run any command, then click **RAW WIRE**. The drawer shows the exact payload sent to the C++ server and the raw response received. For example:

```text
Sent:
*1\r\n$4\r\nPING\r\n

Received:
+PONG\r\n
```

This is useful when explaining that the browser is not calling a mocked REST endpoint: it is sending a command through WebSocket middleware that reaches the real TCP server.

### 6. Demonstrate throughput

Click **RUN 500 OPS**. The bridge sends 1,000 real commands sequentially:

```text
SET bench:0 0
GET bench:0
SET bench:1 1
GET bench:1
...
```

The panel reports:

- **OPS / SEC:** total completed commands divided by measured elapsed time.
- **AVG LATENCY:** mean command round-trip time.
- **P99 LATENCY:** latency at the 99th percentile.
- **SUCCESS / FAIL:** RESP results that were successful versus error responses.

This is a demonstration probe, not a replacement for a formal load-testing tool. It measures the browser-to-bridge-to-TCP path and the C++ server together.

## Testing

### JavaScript checks

```powershell
node --check bridge.js
node --check public/app.js
```

### HTTP check

With the bridge running:

```powershell
Invoke-WebRequest http://localhost:8080/ -UseBasicParsing
```

### End-to-end WebSocket check

With both services running:

```powershell
node -e "const WebSocket=require('ws'); const ws=new WebSocket('ws://localhost:8080'); ws.on('open',()=>ws.send(JSON.stringify({type:'command',args:['PING']}))); ws.on('message',m=>{console.log(m.toString()); ws.close()}); ws.on('error',e=>{console.error(e.message); process.exit(1)})"
```

### Redis command script

On Linux or WSL, if `redis-cli` is installed:

```bash
./test_all.sh
```

## Current Limitations

- The C++ server is a learning-focused Redis clone, not a complete Redis implementation.
- The persistence format is a simplified text dump, not Redis RDB format.
- The browser inspector currently performs separate `TYPE` and `TTL` requests for each key, which is easy to understand but not optimal for very large databases.
- The benchmark uses sequential commands on one bridge connection and should be interpreted as an application-path demonstration.
- Values are parsed as whitespace-separated inline tokens by the C++ fallback parser; use RESP clients when values contain complex whitespace or binary data.

## Original Learning Material

See [Concepts,UseCases&Tests.md](Concepts,UseCases&Tests.md) for explanations of TCP sockets, RESP, data structures, persistence, and command use cases.

## Credits

Created as a C++ Redis server learning project by Selcuk Ata Aksoy. The web console extends the project with a real-time browser demonstration layer.