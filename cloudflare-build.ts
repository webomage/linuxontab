#!/usr/bin/env node
/**
 * Build lightweight Cloudflare Pages output directory (`dist/`) for TabLinux (`LinuxOnTab`).
 *
 * Pure TypeScript build pipeline (runs natively on Node 22.6+/26+ via `node cloudflare-build.ts`):
 * 1. Copies static site assets (`index.html`, `shell/`, `viewer/`, `local/`, `changelog/`).
 * 2. Excludes >25 MiB `shell/alpine.iso` (streamed via Cloudflare R2 or `UPSTREAM_RAW` in `functions/_middleware.ts`).
 * 3. Preserves `packages/index.json` and `packages/index.html` so in-guest `xtiny` GUI package installation works.
 * 4. Audits `packages/*.tar.gz` against `packages/index.json`, separating the 83 active packages from
 *    75 orphaned older revisions (~296 MiB) and writing `dist/packages/r2-manifest.json`.
 * 5. Enforces Cloudflare Pages' hard 25 MiB per-file limit across all files in `dist/`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const PAGES_MAX_FILE_BYTES = 25 * 1024 * 1024;
const TOP_LEVEL_FILES = ["index.html", "robots.txt", "sitemap.xml", "og.png", ".nojekyll"] as const;
const COPY_DIRS = ["shell", "viewer", "local", "changelog"] as const;

export interface PackageIndexEntry {
  file?: string;
  filename?: string;
  archive?: string;
  url?: string;
  tarball?: string;
  [key: string]: unknown;
}

export interface R2AssetManifest {
  schema: "w0m.tablinux.r2-manifest.v1";
  maxPagesFileBytes: number;
  bundleSmallPackages: boolean;
  activePackagesCount: number;
  orphanedPackagesCount: number;
  bundledInPages: string[];
  proxiedViaR2OrRaw: string[];
  orphanedTarballs: string[];
  distTotalBytes: number;
}

export function collectReferencedPackages(indexJsonPath: string): string[] {
  if (!fs.existsSync(indexJsonPath)) return [];
  const raw = JSON.parse(fs.readFileSync(indexJsonPath, "utf8")) as Record<string, unknown> | unknown[];
  const pkgs =
    raw && typeof raw === "object" && !Array.isArray(raw) && "packages" in raw
      ? (raw.packages as Record<string, unknown> | unknown[])
      : raw;
  const items: unknown[] = Array.isArray(pkgs)
    ? pkgs
    : pkgs && typeof pkgs === "object"
      ? Object.values(pkgs)
      : [];

  const referenced = new Set<string>();
  for (const item of items) {
    if (item && typeof item === "object") {
      const entry = item as PackageIndexEntry;
      const candidate =
        entry.file ?? entry.filename ?? entry.archive ?? entry.tarball ?? entry.url;
      if (typeof candidate === "string" && candidate.trim().endsWith(".tar.gz")) {
        referenced.add(path.basename(candidate.trim()));
      }
    }
  }
  return Array.from(referenced).sort();
}

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

export function buildCloudflareDist(options: {
  rootDir: string;
  outDir?: string;
  bundleSmallPackages?: boolean;
  maxFileBytes?: number;
}): R2AssetManifest {
  const root = path.resolve(options.rootDir);
  const out = path.resolve(options.outDir ?? path.join(root, "dist"));
  const bundleSmallPackages = Boolean(options.bundleSmallPackages);
  const maxFileBytes = options.maxFileBytes ?? PAGES_MAX_FILE_BYTES;

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  for (const fname of TOP_LEVEL_FILES) {
    const src = path.join(root, fname);
    if (fs.existsSync(src) && fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(out, fname));
    }
  }

  for (const dname of COPY_DIRS) {
    const srcDir = path.join(root, dname);
    if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
      fs.cpSync(srcDir, path.join(out, dname), { recursive: true, verbatimSymlinks: true });
    }
  }

  // Strip 48 MiB Alpine ISO from static Pages output (streamed via R2 / UPSTREAM_RAW in functions/_middleware.ts)
  const alpineIso = path.join(out, "shell", "alpine.iso");
  fs.rmSync(alpineIso, { force: true });

  const pkgSrcDir = path.join(root, "packages");
  const pkgOutDir = path.join(out, "packages");
  fs.mkdirSync(pkgOutDir, { recursive: true });

  for (const metaFile of ["index.json", "index.html"]) {
    const srcMeta = path.join(pkgSrcDir, metaFile);
    if (fs.existsSync(srcMeta) && fs.statSync(srcMeta).isFile()) {
      fs.copyFileSync(srcMeta, path.join(pkgOutDir, metaFile));
    }
  }

  const referenced = collectReferencedPackages(path.join(pkgSrcDir, "index.json"));
  const referencedSet = new Set(referenced);
  const allTars = fs.existsSync(pkgSrcDir)
    ? fs
        .readdirSync(pkgSrcDir)
        .filter((name) => name.endsWith(".tar.gz"))
        .sort()
    : [];
  const orphans = allTars.filter((name) => !referencedSet.has(name));

  const proxiedViaR2OrRaw: string[] = ["shell/alpine.iso"];
  const bundledInPages: string[] = [];

  for (const fn of referenced) {
    const srcTar = path.join(pkgSrcDir, fn);
    if (!fs.existsSync(srcTar)) continue;
    const size = fs.statSync(srcTar).size;
    if (size > maxFileBytes) {
      proxiedViaR2OrRaw.push(`packages/${fn}`);
    } else if (bundleSmallPackages) {
      fs.copyFileSync(srcTar, path.join(pkgOutDir, fn));
      bundledInPages.push(`packages/${fn}`);
    } else {
      proxiedViaR2OrRaw.push(`packages/${fn}`);
    }
  }

  const manifest: R2AssetManifest = {
    schema: "w0m.tablinux.r2-manifest.v1",
    maxPagesFileBytes: maxFileBytes,
    bundleSmallPackages,
    activePackagesCount: referenced.length,
    orphanedPackagesCount: orphans.length,
    bundledInPages,
    proxiedViaR2OrRaw,
    orphanedTarballs: orphans,
    distTotalBytes: 0,
  };

  fs.writeFileSync(
    path.join(pkgOutDir, "r2-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8"
  );

  const oversized: string[] = [];
  let totalBytes = 0;
  for (const fpath of walkFiles(out)) {
    const sz = fs.statSync(fpath).size;
    totalBytes += sz;
    if (sz > maxFileBytes) {
      oversized.push(`${path.relative(out, fpath)} (${sz} bytes)`);
    }
  }

  if (oversized.length > 0) {
    throw new Error(
      `Cloudflare Pages 25 MiB per-file limit exceeded: ${oversized.join(", ")}`
    );
  }

  manifest.distTotalBytes = totalBytes;
  fs.writeFileSync(
    path.join(pkgOutDir, "r2-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8"
  );
  return manifest;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const args = process.argv.slice(2);
  let bundleSmallPackages = false;
  let rootDir = path.dirname(fileURLToPath(import.meta.url));
  let outDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--bundle-small-packages") {
      bundleSmallPackages = true;
    } else if (arg === "--root" && args[i + 1]) {
      rootDir = args[++i];
    } else if (arg === "--out" && args[i + 1]) {
      outDir = args[++i];
    } else {
      console.error(
        "Usage: node cloudflare-build.ts [--bundle-small-packages] [--root <dir>] [--out <dir>]"
      );
      process.exit(2);
    }
  }

  const manifest = buildCloudflareDist({ rootDir, outDir, bundleSmallPackages });
  const resolvedOut = path.resolve(outDir ?? path.join(rootDir, "dist"));
  const mib = (manifest.distTotalBytes / (1024 * 1024)).toFixed(1);
  console.log(
    `Cloudflare Pages output ready: ${resolvedOut} (${mib} MiB, active=${manifest.activePackagesCount}, orphans_excluded=${manifest.orphanedPackagesCount})`
  );
}
