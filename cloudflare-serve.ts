#!/usr/bin/env node
/**
 * Local COOP/COEP + HTTP Range (`206 Partial Content`) + `/__k7/rpc` TypeScript Server for TabLinux.
 *
 * Replaces raw Python/Bash local serving with a zero-dependency Node TypeScript HTTP server:
 * - Enforces `COOP: same-origin`, `COEP: require-corp`, `CORP: cross-origin`, `X-Content-Type-Options: nosniff`,
 *   and `CSP: frame-ancestors 'self' http://127.0.0.1:* http://localhost:* https://*.webomage.com`.
 * - Blocks dotfile and path-traversal requests (`/.git`, `/.env`, `/.wrangler`, `..` -> 403).
 * - Supports byte-range streaming (`206 Partial Content`) for `shell/alpine.iso` and `packages/*.tar.gz`.
 * - Exposes `/__k7/rpc` using the shared TypeScript implementation from `functions/_middleware.ts`.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildK7RpcPayload,
  isBlockedPath,
  sanitizeSlug,
} from "./functions/_middleware.ts";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".iso": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".gz": "application/gzip",
  ".sh": "text/x-shellscript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

function commonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy":
      "frame-ancestors 'self' http://127.0.0.1:* http://localhost:* https://*.webomage.com",
    "Cache-Control": "no-store",
    ...extra,
  };
}

export function createTabLinuxServer(rootDir: string): http.Server {
  const resolvedRoot = path.resolve(rootDir);

  return http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const pathname = reqUrl.pathname;

    if (isBlockedPath(pathname)) {
      const body = JSON.stringify({ error: "Forbidden path" });
      res.writeHead(403, commonHeaders({ "Content-Type": "application/json; charset=utf-8" }));
      res.end(method === "HEAD" ? undefined : body);
      return;
    }

    if (pathname === "/__k7/rpc") {
      const payload = buildK7RpcPayload({
        module: reqUrl.searchParams.get("module") ?? reqUrl.searchParams.get("k7"),
        project: reqUrl.searchParams.get("project"),
        env: reqUrl.searchParams.get("env"),
        runtime: "local-node-ts",
      });
      const body = JSON.stringify(payload);
      res.writeHead(200, commonHeaders({ "Content-Type": "application/json; charset=utf-8" }));
      res.end(method === "HEAD" ? undefined : body);
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, commonHeaders({ Allow: "GET, HEAD" }));
      res.end();
      return;
    }

    const decodedPath = decodeURIComponent(pathname);
    let candidate = path.resolve(resolvedRoot, "." + decodedPath);
    if (!candidate.startsWith(resolvedRoot)) {
      res.writeHead(403, commonHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
      res.end("Forbidden");
      return;
    }

    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      candidate = path.join(candidate, "index.html");
    }

    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      res.writeHead(404, commonHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
      res.end(method === "HEAD" ? undefined : "Not Found");
      return;
    }

    const stat = fs.statSync(candidate);
    const ext = path.extname(candidate).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    const rangeHeader = req.headers.range;

    if (rangeHeader && rangeHeader.startsWith("bytes=")) {
      const parts = rangeHeader.slice(6).split(",")[0].trim().split("-");
      const startStr = parts[0];
      const endStr = parts[1];
      let start = startStr ? parseInt(startStr, 10) : 0;
      let end = endStr ? parseInt(endStr, 10) : stat.size - 1;
      if (!startStr && endStr) {
        const suffixLen = parseInt(endStr, 10);
        start = Math.max(0, stat.size - suffixLen);
        end = stat.size - 1;
      }
      if (
        Number.isNaN(start) ||
        Number.isNaN(end) ||
        start < 0 ||
        end >= stat.size ||
        start > end
      ) {
        res.writeHead(
          416,
          commonHeaders({ "Content-Range": `bytes */${stat.size}` })
        );
        res.end();
        return;
      }
      const chunkLen = end - start + 1;
      res.writeHead(
        206,
        commonHeaders({
          "Content-Type": contentType,
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Content-Length": String(chunkLen),
        })
      );
      if (method === "HEAD") {
        res.end();
        return;
      }
      fs.createReadStream(candidate, { start, end }).pipe(res);
      return;
    }

    res.writeHead(
      200,
      commonHeaders({
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Content-Length": String(stat.size),
      })
    );
    if (method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(candidate).pipe(res);
  });
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const args = process.argv.slice(2);
  let port = 8770;
  let mod = "hub";
  let project = "w0m";
  let infEnv = "beta";
  let dryRun = false;
  let rootDir = path.dirname(fileURLToPath(import.meta.url));

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--module" && args[i + 1]) {
      mod = sanitizeSlug(args[++i], "hub");
    } else if (arg === "--project" && args[i + 1]) {
      project = sanitizeSlug(args[++i], "w0m");
    } else if (arg === "--env" && args[i + 1]) {
      infEnv = sanitizeSlug(args[++i], "beta");
    } else if (arg === "--root" && args[i + 1]) {
      rootDir = args[++i];
    } else if (/^\d+$/.test(arg)) {
      port = parseInt(arg, 10);
    }
  }

  const resolvedRoot = path.resolve(rootDir);
  const url =
    `http://127.0.0.1:${port}/shell/` +
    `?autoboot=1&iso=alpine.iso&net=off&k7=${mod}&project=${project}&env=${infEnv}`;
  console.log(`LinuxOnTab Root : ${resolvedRoot}`);
  console.log(`Active URL      : ${url}`);
  if (dryRun) {
    process.exit(0);
  }
  const server = createTabLinuxServer(resolvedRoot);
  server.listen(port, "127.0.0.1");
}
