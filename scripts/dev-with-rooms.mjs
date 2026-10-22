// Local app + room API: node scripts/dev-with-rooms.mjs [--port 53793] [--db /tmp/beat-rooms.sqlite]
// Storage is in memory unless --db names a local SQLite file.
import { createServer as createHttpServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createServer as createViteServer } from "vite";
import worker from "../worker/index.js";

const { values } = parseArgs({
  options: { port: { type: "string" }, db: { type: "string" } },
});
const port = Number(values.port ?? process.env.PORT ?? 53793);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("The local port must be an integer between 0 and 65535.");
}

const sqlite = new DatabaseSync(values.db || ":memory:");
const DB = {
  prepare(sql) {
    const statement = sqlite.prepare(sql);
    const bound = (parameters = []) => ({
      bind(...nextParameters) { return bound(nextParameters); },
      async first(column) {
        const row = statement.get(...parameters);
        return row ? (column === undefined ? row : row[column]) : null;
      },
      async all() { return { success: true, results: statement.all(...parameters) }; },
      _run() {
        const result = statement.run(...parameters);
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
      async run() { return this._run(); },
    });
    return bound();
  },
  async batch(statements) {
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement._run());
      sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  },
};

let vite;
const server = createHttpServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url || "/", "http://127.0.0.1");
    if (!url.pathname.startsWith("/api/rooms/") && !url.pathname.startsWith("/api/projects")) {
      vite.middlewares(incoming, outgoing, () => {
        outgoing.writeHead(404);
        outgoing.end("Not found");
      });
      return;
    }

    const headers = new Headers();
    for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
      headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
    }
    const abort = new AbortController();
    incoming.once("aborted", () => abort.abort());
    const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
    const request = new Request(url, {
      method: incoming.method,
      headers,
      signal: abort.signal,
      ...(hasBody ? { body: Readable.toWeb(incoming), duplex: "half" } : {}),
    });
    const response = await worker.fetch(request, {
      DB,
      ASSETS: { async fetch() { return new Response("Not found", { status: 404 }); } },
    });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body && incoming.method !== "HEAD") {
      await pipeline(Readable.fromWeb(response.body), outgoing);
    } else {
      outgoing.end();
    }
  } catch (error) {
    if (!outgoing.headersSent) {
      outgoing.writeHead(500, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: "Local request failed" }));
    } else {
      outgoing.destroy();
    }
    if (!incoming.aborted) console.error(error);
  }
});

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  const stopped = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await Promise.all([stopped, vite?.close()]);
  sqlite.close();
}

try {
  vite = await createViteServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { middlewareMode: true, hmr: { server } },
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.log(`Local Beat with room storage: http://127.0.0.1:${server.address().port}/`);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      close().catch((error) => { console.error(error); process.exitCode = 1; });
    });
  }
} catch (error) {
  await close();
  throw error;
}
