/**
 * Cloudflare Pages Function Middleware (`functions/_middleware.ts`) for TabLinux (`webomage/linuxontab`).
 *
 * Capabilities:
 * 1. Multi-mode authentication:
 *    - Salted PBKDF2-SHA256 (`100,000..600,000` iterations, constant-time verify) + HMAC-SHA256 `__Host-lot_session` cookies
 *    - Cloudflare Zero Trust Access (`Cf-Access-Jwt-Assertion` when `CF_ACCESS_ENABLED === "1"`)
 *    - Programmatic Bearer token (`Authorization: Bearer <LOT_BEARER_TOKEN>`) for `@k7` CLI & `w0m-cp`
 * 2. Cross-origin isolation & security headers on every response:
 *    - `Cross-Origin-Opener-Policy: same-origin`
 *    - `Cross-Origin-Embedder-Policy: require-corp`
 *    - `Cross-Origin-Resource-Policy: cross-origin`
 *    - `X-Content-Type-Options: nosniff`
 *    - `Content-Security-Policy: frame-ancestors 'self' http://127.0.0.1:* http://localhost:* https://*.webomage.com`
 * 3. Path traversal & dotfile blocking (`..`, `/.git`, `/.env`, `/.wrangler` -> 403).
 * 4. Cloudflare R2-First (`env.LOT_ASSETS`) + `UPSTREAM_RAW` fallback streaming with HTTP `Range` (`206 Partial Content`)
 *    for `/shell/alpine.iso` and `/packages/*.tar.gz`.
 * 5. Edge `/__k7/rpc` endpoint serving structured JSON for `@k7` & `@wom` crew modules.
 */

export interface R2Range {
  offset?: number;
  length?: number;
  suffix?: number;
}

export interface R2ObjectBody {
  body: ReadableStream<Uint8Array> | null;
  size: number;
  httpEtag: string;
  range?: R2Range;
  writeHttpMetadata(headers: Headers): void;
}

export interface R2BucketBinding {
  get(key: string, options?: { range?: Headers }): Promise<R2ObjectBody | null>;
}

export interface TabLinuxEnv {
  AUTH_USERNAME?: string;
  AUTH_PASSWORD_HASH?: string;
  SESSION_SECRET?: string;
  LOT_BEARER_TOKEN?: string;
  CF_ACCESS_ENABLED?: string;
  UPSTREAM_RAW?: string;
  LOT_ASSETS?: R2BucketBinding;
}

export interface PagesContext {
  request: Request;
  env: TabLinuxEnv;
  next: () => Promise<Response>;
}

const encoder = new TextEncoder();
const COOKIE_NAME = "__Host-lot_session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_UPSTREAM_RAW = "https://raw.githubusercontent.com/webomage/linuxontab/main";
const SLUG_RE = /^[a-z0-9_-]{1,32}$/i;

export function sanitizeSlug(value: string | null | undefined, fallback: string): string {
  const s = String(value ?? "").trim();
  return SLUG_RE.test(s) ? s.toLowerCase() : fallback;
}

export function applyIsolationAndSecurityHeaders(headers: Headers): Headers {
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (!headers.has("Content-Security-Policy")) {
    headers.set(
      "Content-Security-Policy",
      "frame-ancestors 'self' http://127.0.0.1:* http://localhost:* https://*.webomage.com"
    );
  }
  return headers;
}

function json(
  data: Record<string, unknown>,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  applyIsolationAndSecurityHeaders(headers);
  return new Response(JSON.stringify(data), { status, headers });
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function getSessionKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function createSession(secret: string): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = encoder.encode("linuxontab-session-v1:" + expires);
  const key = await getSessionKey(secret);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, payload));
  return expires + "." + base64url(signature);
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function validSession(request: Request, env: TabLinuxEnv): Promise<boolean> {
  if (env.CF_ACCESS_ENABLED === "1" && request.headers.get("Cf-Access-Jwt-Assertion")) {
    return true;
  }
  if (typeof env.LOT_BEARER_TOKEN === "string" && env.LOT_BEARER_TOKEN.length >= 24) {
    const auth = request.headers.get("Authorization") ?? "";
    if (auth.startsWith("Bearer ")) {
      const given = encoder.encode(auth.slice(7).trim());
      const wanted = encoder.encode(env.LOT_BEARER_TOKEN.trim());
      if (constantTimeEqual(given, wanted)) return true;
    }
  }
  const secret = env.SESSION_SECRET;
  if (!secret || secret.length < 32) return false;
  const cookie = request.headers.get("Cookie") ?? "";
  const entry = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(COOKIE_NAME + "="));
  if (!entry) return false;
  const token = entry.slice(COOKIE_NAME.length + 1);
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const expires = Number(token.slice(0, dot));
  if (!Number.isSafeInteger(expires)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (expires <= now || expires > now + SESSION_SECONDS) return false;
  try {
    const signature = fromBase64url(token.slice(dot + 1));
    const key = await getSessionKey(secret);
    return await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      encoder.encode("linuxontab-session-v1:" + expires)
    );
  } catch {
    return false;
  }
}

function fromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{32,128}$/i.test(value) || value.length % 2 !== 0) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function verifyPassword(
  password: string,
  encodedHash: string | undefined
): Promise<boolean> {
  const normalized = String(encodedHash ?? "").trim();
  const parts = normalized.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  const salt = fromHex(parts[2]);
  const expected = fromHex(parts[3]);
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < 100000 ||
    iterations > 600000 ||
    !salt ||
    salt.length < 16 ||
    !expected ||
    expected.length !== 32
  ) {
    return false;
  }
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const derived = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
        key,
        256
      )
    );
    return constantTimeEqual(derived, expected);
  } catch {
    return false;
  }
}

function originIsValid(request: Request): boolean {
  return request.headers.get("Origin") === new URL(request.url).origin;
}

export function isBlockedPath(pathname: string): boolean {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  if (decoded.includes("..") || decoded.includes("\0")) return true;
  const segments = decoded.split("/").filter(Boolean);
  for (const seg of segments) {
    if (
      seg === ".git" ||
      seg === ".env" ||
      seg === ".wrangler" ||
      (seg.startsWith(".") && seg !== ".nojekyll" && seg !== ".well-known")
    ) {
      return true;
    }
  }
  return false;
}

function loginPage(): Response {
  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="dark">',
    "<title>TabLinux · Webomage Sign in</title>",
    "<style>",
    ":root{color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#090d12;color:#e7edf5}",
    "*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}",
    "main{width:min(100%,390px);padding:32px;border:1px solid #263342;border-radius:18px;background:#101821;box-shadow:0 24px 80px #0008}",
    ".mark{display:grid;place-items:center;width:48px;height:48px;border-radius:14px;background:#1d2b3a;color:#8dc5ff;font-size:24px}",
    "h1{font-size:24px;margin:22px 0 6px}p{color:#9eacbb;line-height:1.5;margin:0 0 24px}",
    "label{display:block;font-size:13px;color:#c4d0dc;margin:16px 0 7px}",
    "input{width:100%;padding:12px 13px;border:1px solid #344456;border-radius:9px;background:#0a1119;color:#fff;font:inherit;outline:none}",
    "input:focus{border-color:#6ba9e8;box-shadow:0 0 0 3px #6ba9e822}",
    "button{width:100%;margin-top:22px;padding:12px;border:0;border-radius:9px;background:#8dc5ff;color:#07111d;font:600 15px inherit;cursor:pointer}",
    "button:disabled{opacity:.6;cursor:wait}#error{min-height:20px;margin:12px 0 0;color:#ff9d9d;font-size:13px}",
    "small{display:block;margin-top:18px;color:#6f8091;text-align:center}",
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    '<div class="mark" aria-hidden="true">⌘</div>',
    "<h1>TabLinux (@k7)</h1>",
    "<p>This Webomage TabLinux instance is private. Sign in to open the WASM Linux environment.</p>",
    '<form id="login">',
    '<label for="username">Username</label>',
    '<input id="username" name="username" autocomplete="username" required autofocus>',
    '<label for="password">Password</label>',
    '<input id="password" name="password" type="password" autocomplete="current-password" required>',
    '<button id="submit" type="submit">Sign in</button>',
    '<div id="error" role="alert" aria-live="polite"></div>',
    "</form>",
    "<small>Protected access · COOP/COEP isolated WASM sandbox</small>",
    "</main>",
    "<script>",
    'const form=document.getElementById("login");const button=document.getElementById("submit");const error=document.getElementById("error");',
    'form.addEventListener("submit",async(event)=>{event.preventDefault();button.disabled=true;button.textContent="Checking…";error.textContent="";',
    'try{const body=new URLSearchParams(new FormData(form));const response=await fetch("/__auth/login",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});',
    'if(!response.ok)throw new Error(response.status===401?"Incorrect username or password.":"Sign-in failed. Try again.");location.replace(location.pathname+location.search);',
    '}catch(err){error.textContent=err.message||"Could not sign in.";}finally{button.disabled=false;button.textContent="Sign in";}});',
    "</script>",
    "</body>",
    "</html>",
  ].join("\n");
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, private",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' http://127.0.0.1:* http://localhost:* https://*.webomage.com",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

async function proxyLargeAsset(
  request: Request,
  env: TabLinuxEnv,
  pathname: string
): Promise<Response> {
  const objectKey = pathname.replace(/^\/+/, "");
  if (env.LOT_ASSETS && typeof env.LOT_ASSETS.get === "function") {
    const rangeHeader = request.headers.get("Range");
    const r2Obj = await env.LOT_ASSETS.get(
      objectKey,
      rangeHeader ? { range: request.headers } : undefined
    );
    if (r2Obj) {
      const headers = new Headers();
      r2Obj.writeHttpMetadata(headers);
      headers.set("ETag", r2Obj.httpEtag);
      headers.set("Accept-Ranges", "bytes");
      headers.set(
        "Content-Type",
        pathname.endsWith(".iso")
          ? "application/octet-stream"
          : headers.get("Content-Type") || "application/octet-stream"
      );
      headers.set("Cache-Control", "private, max-age=3600");
      applyIsolationAndSecurityHeaders(headers);
      let status = 200;
      if (rangeHeader && r2Obj.range) {
        const offset = r2Obj.range.offset ?? 0;
        const length = r2Obj.range.length ?? r2Obj.size;
        headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${r2Obj.size}`);
        headers.set("Content-Length", String(length));
        status = 206;
      } else {
        headers.set("Content-Length", String(r2Obj.size));
      }
      return new Response(request.method === "HEAD" ? null : r2Obj.body, {
        status,
        headers,
      });
    }
  }

  const upstreamBase = String(env.UPSTREAM_RAW || DEFAULT_UPSTREAM_RAW).replace(/\/+$/, "");
  const target = upstreamBase + pathname;
  const reqHeaders = new Headers();
  for (const name of ["Range", "If-Range", "If-None-Match"]) {
    const value = request.headers.get(name);
    if (value) reqHeaders.set(name, value);
  }
  const upstream = await fetch(target, {
    method: request.method,
    headers: reqHeaders,
    redirect: "follow",
  });
  const responseHeaders = new Headers();
  for (const name of [
    "Content-Length",
    "Content-Range",
    "ETag",
    "Last-Modified",
    "Accept-Ranges",
  ]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set(
    "Content-Type",
    pathname.endsWith(".iso")
      ? "application/octet-stream"
      : upstream.headers.get("Content-Type") || "application/octet-stream"
  );
  responseHeaders.set("Cache-Control", "private, no-store");
  applyIsolationAndSecurityHeaders(responseHeaders);
  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export function buildK7RpcPayload(params: {
  module?: string | null;
  project?: string | null;
  env?: string | null;
  runtime?: string;
}): Record<string, unknown> {
  const mod = sanitizeSlug(params.module, "hub");
  const project = sanitizeSlug(params.project, "w0m");
  const infEnv = sanitizeSlug(params.env, "beta");
  const runtime = params.runtime ?? "cloudflare-pages-edge-ts";
  const upperProj = project.toUpperCase().replace(/-/g, "_");
  const randBytes = new Uint8Array(24);
  crypto.getRandomValues(randBytes);
  const hexToken = Array.from(randBytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const tokenPreview = `k7_${infEnv}_${hexToken.slice(0, 32)}`;

  const acpEnvelope = {
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: {
      protocolVersion: "2025-03-26",
      projectScope: {
        projectId: project,
        accountEmail: `${project}@webomage.com`,
        crossProjectAccess: false,
      },
    },
  };

  const lines: string[] = [
    `\x1b[1;36m======================================================================\x1b[0m`,
    `\x1b[1;36m @k7 TabLinux TypeScript Runtime | module=${mod} | project=${project} | env=${infEnv}\x1b[0m`,
    `\x1b[1;36m======================================================================\x1b[0m`,
  ];

  if (mod === "pwd" || mod === "k7pwd") {
    lines.push(
      `\x1b[1;33m[k7pwd] WebCrypto CSPRNG Secrets (${runtime}):\x1b[0m`,
      `  csprng-hex (48c)        : ${hexToken}`,
      `  prefixed-api-key        : ${tokenPreview}`
    );
  } else if (mod === "env" || mod === "k7env") {
    lines.push(
      `\x1b[1;33m[k7env] Per-Project Infisical & Mistral Free-Tier Scope:\x1b[0m`,
      `  Account Email        : ${project}@webomage.com`,
      `  Infisical Secret Key : MISTRAL_API_KEY_${upperProj}`,
      `  Private Vault Scope  : w0m-web/projects/${project}/vault (cross-project: DENIED)`
    );
  } else if (mod === "kb" || mod === "k7kb") {
    lines.push(
      `\x1b[1;33m[k7kb] Knowledge Base Search, Obsidian Vaults & Semantic Data Mining:\x1b[0m`,
      `  Project Vault        : w0m-web/projects/${project}/vault (r2://${project}/, cross_project_access=false)`,
      `  Hybrid Retrieval     : SQLite FTS5 BM25 + 128-dim SVD Cosine RRF`
    );
  } else if (mod === "seo-geo" || mod === "seo" || mod === "geo") {
    lines.push(
      `\x1b[1;33m[k7kb seo-geo] Crew SEO, GEO & Perimeter Security Scanner:\x1b[0m`,
      `  SEO Pillar (100pt)   : <title>, <meta description>, rel=canonical, OpenGraph, <h1>, robots.txt, sitemap.xml`,
      `  GEO Pillar (100pt)   : /llms.txt index, Schema.org JSON-LD entity graph, GPTBot/ClaudeBot/Perplexity/Mistral`,
      `  Security (100pt)     : HTTPS/TLS, HSTS, CSP, COOP/COEP, X-Content-Type-Options: nosniff, security.txt`
    );
  } else if (mod === "obs" || mod === "analytics") {
    lines.push(
      `\x1b[1;33m[k7kb analytics] Multi-Channel Analytics & Enterprise Observability:\x1b[0m`,
      `  Product/Marketing    : MS Clarity, Google Analytics 4 (GA4), Meta Pixel, LinkedIn, PostHog, Tinybird/CF`,
      `  Enterprise APM/SIEM  : Sentry Enterprise, Datadog APM/RUM/Logs, Grafana Cloud (LGTM), OpenTelemetry + PagerDuty`
    );
  } else if (mod === "acp" || mod === "sessions") {
    lines.push(
      `\x1b[1;33m[k7kb acp] Same-Host Agent Session Discovery & ACP (2025-03-26):\x1b[0m`,
      `  Methods              : initialize, session/new, session/load, session/prompt, session/cancel, host/discover`,
      `  Envelope             : ${JSON.stringify(acpEnvelope)}`
    );
  } else {
    lines.push(
      `\x1b[1;32m[@k7 & @wom Crew Unified Module Registry (${runtime})]\x1b[0m`,
      `  [1] env (k7env) | [2] pwd (k7pwd) | [3] vm (k7d) | [4] k8s (k7s) | [5] cloud (k7c)`,
      `  [6] llm (k7llm) | [7] spec (k7spec) | [8] sol (k7sol) | [9] tg (k7tg)`,
      `  [10] kb (k7kb)  | [11] seo-geo | [12] obs (analytics) | [13] acp (sessions)`
    );
  }

  return {
    ok: true,
    runtime,
    module: mod,
    project,
    infisicalEnv: infEnv,
    projectScope: {
      projectId: project,
      accountEmail: `${project}@webomage.com`,
      mistralSecretKey: `MISTRAL_API_KEY_${upperProj}`,
      vaultPath: `w0m-web/projects/${project}/vault`,
      r2BucketPrefix: `r2://${project}/`,
      crossProjectAccess: false,
    },
    generatedTokenPreview:
      mod === "pwd" || mod === "k7pwd" ? tokenPreview : undefined,
    acpEnvelope,
    ansiReport: lines.join("\n") + "\n",
  };
}

export function handleK7EdgeRpc(request: Request): Response {
  const url = new URL(request.url);
  return json(
    buildK7RpcPayload({
      module: url.searchParams.get("module") ?? url.searchParams.get("k7"),
      project: url.searchParams.get("project"),
      env: url.searchParams.get("env"),
      runtime: "cloudflare-pages-edge-ts",
    })
  );
}

export async function onRequest(context: PagesContext): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (isBlockedPath(path)) {
    return json({ error: "Forbidden path" }, 403);
  }

  if (path === "/__auth/login") {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
    }
    if (!originIsValid(request)) return json({ error: "Invalid origin" }, 403);
    if (
      !env.AUTH_USERNAME ||
      !env.AUTH_PASSWORD_HASH ||
      !env.SESSION_SECRET ||
      env.SESSION_SECRET.length < 32
    ) {
      return json(
        {
          error:
            "Authentication is not configured. Add AUTH_USERNAME, AUTH_PASSWORD_HASH and a 32+ character SESSION_SECRET.",
        },
        503
      );
    }
    const length = Number(request.headers.get("Content-Length") || "0");
    if (length > 4096) return json({ error: "Request too large" }, 413);
    let form: URLSearchParams;
    try {
      const bodyText = await request.text();
      if (encoder.encode(bodyText).byteLength > 4096) {
        return json({ error: "Request too large" }, 413);
      }
      form = new URLSearchParams(bodyText);
    } catch {
      return json({ error: "Invalid request" }, 400);
    }
    const username = form.get("username") || "";
    const password = form.get("password") || "";
    if (username.length > 128 || password.length > 1024) {
      return json({ error: "Invalid credentials" }, 401);
    }
    const [givenUser, wantedUser, passwordMatches] = await Promise.all([
      crypto.subtle.digest("SHA-256", encoder.encode(username)),
      crypto.subtle.digest("SHA-256", encoder.encode(env.AUTH_USERNAME)),
      verifyPassword(password, env.AUTH_PASSWORD_HASH),
    ]);
    const userMatches = constantTimeEqual(
      new Uint8Array(givenUser),
      new Uint8Array(wantedUser)
    );
    if (!(userMatches && passwordMatches)) {
      return json({ error: "Invalid credentials" }, 401);
    }
    const token = await createSession(env.SESSION_SECRET);
    return json(
      { ok: true },
      200,
      {
        "Set-Cookie":
          COOKIE_NAME +
          "=" +
          token +
          "; Path=/; Max-Age=" +
          SESSION_SECONDS +
          "; Secure; HttpOnly; SameSite=Strict",
      }
    );
  }

  if (path === "/__auth/logout") {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
    }
    if (!originIsValid(request)) return json({ error: "Invalid origin" }, 403);
    return new Response(null, {
      status: 303,
      headers: applyIsolationAndSecurityHeaders(
        new Headers({
          Location: "/",
          "Set-Cookie":
            COOKIE_NAME + "=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict",
          "Cache-Control": "no-store",
        })
      ),
    });
  }

  const authConfigured =
    Boolean(
      env.AUTH_USERNAME &&
        env.AUTH_PASSWORD_HASH &&
        env.SESSION_SECRET &&
        env.SESSION_SECRET.length >= 32
    ) ||
    env.CF_ACCESS_ENABLED === "1" ||
    (typeof env.LOT_BEARER_TOKEN === "string" && env.LOT_BEARER_TOKEN.length >= 24);

  if (!authConfigured) {
    return new Response("Authentication is not configured.", {
      status: 503,
      headers: applyIsolationAndSecurityHeaders(
        new Headers({
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        })
      ),
    });
  }

  if (!(await validSession(request, env))) {
    const acceptsHtml = (request.headers.get("Accept") || "").includes("text/html");
    if (acceptsHtml || path.endsWith("/") || path.endsWith(".html")) return loginPage();
    return json({ error: "Authentication required" }, 401);
  }

  if (path === "/__k7/rpc") {
    return handleK7EdgeRpc(request);
  }

  if (request.method === "GET" || request.method === "HEAD") {
    if (
      path === "/shell/alpine.iso" ||
      (path.startsWith("/packages/") && path.endsWith(".tar.gz"))
    ) {
      return proxyLargeAsset(request, env, path);
    }
  }

  const response = await context.next();
  const responseHeaders = new Headers(response.headers);
  applyIsolationAndSecurityHeaders(responseHeaders);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}
