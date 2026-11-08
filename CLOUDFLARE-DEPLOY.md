# Deploy TabLinux (`webomage/linuxontab`) to Cloudflare Pages + R2 (TypeScript)

This fork ships a pure TypeScript Cloudflare Pages + R2 deployment pipeline ([`cloudflare-build.ts`](file:///home/aleksei/Projects/!self/w0m/w0m-pr/linuxontab/cloudflare-build.ts), [`functions/_middleware.ts`](file:///home/aleksei/Projects/!self/w0m/w0m-pr/linuxontab/functions/_middleware.ts), and [`wrangler.toml`](file:///home/aleksei/Projects/!self/w0m/w0m-pr/linuxontab/wrangler.toml)) tailored for the `@wom` / `@k7` ecosystem (`AgDR-0055` Cloudflare-First).

## Key Improvements over Upstream PR `#20`

1. **100% TypeScript Build & Edge Middleware (`cloudflare-build.ts` + `functions/_middleware.ts`):**
   - Replaces raw Bash + heredocs with strictly typed TypeScript runnable natively on Node 22.6+/26+ (`node cloudflare-build.ts` / `npm run build:cf`) and compiled natively by Cloudflare Pages Functions.
2. **Cross-Origin Isolation (`COOP` / `COEP` / `CORP`) Preserved:**
   - Attaches `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, and `Cross-Origin-Resource-Policy: cross-origin` on all authenticated responses so `v86` `SharedArrayBuffer` works both standalone and when embedded in `w0m-cp` (`/me/work`) or Orca browser panes.
3. **In-Guest Package Catalog Intact (`packages/index.json` + `r2-manifest.json`):**
   - Preserves `packages/index.json` and `packages/index.html` inside `dist/packages/` so `xtiny`'s `"Install Software"` catalog remains functional, while auditing and excluding `75` orphaned older package tarballs (`296.0 MiB`).
4. **Cloudflare R2-First Streaming with `Range` (`206 Partial Content`) Support:**
   - Streams `/shell/alpine.iso` (`48 MiB`) and `/packages/*.tar.gz` from the bound `LOT_ASSETS` R2 bucket first (zero egress cost, no GitHub rate limit), falling back to `UPSTREAM_RAW` (`https://raw.githubusercontent.com/webomage/linuxontab/main`).
5. **Multi-Mode Authentication + `/__k7/rpc` Edge Bridge:**
   - Supports PBKDF2-SHA256 (`310,000` iterations) + HMAC-SHA256 `__Host-lot_session` cookies, Cloudflare Zero Trust Access (`CF_ACCESS_ENABLED=1`), and programmatic `LOT_BEARER_TOKEN` headers.
   - Exposes `/__k7/rpc` for `@k7` module execution (`hub`, `env`, `pwd`, `kb`, `seo-geo`, `obs`, `acp`).

## Build & Verify Locally

```bash
node cloudflare-build.ts
```
