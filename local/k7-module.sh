#!/bin/sh
# @k7 Module Runner inside LinuxOnTab (Alpine v86 guest & Orca Embedded Browser Tab)
# Usage: sh /local/k7-module.sh [hub|env|pwd|vm|k8s|cloud|llm|spec|sol|tg] [project] [env]

MODULE="${1:-hub}"
PROJECT="${2:-w0m}"
INF_ENV="${3:-beta}"
UPPER_PROJ="$(printf '%s' "$PROJECT" | tr '[:lower:]-' '[:upper:]_')"

printf '\033[1;36m======================================================================\033[0m\n'
printf '\033[1;36m @k7 LinuxOnTab Module Runtime | module=%s | project=%s | env=%s\033[0m\n' "$MODULE" "$PROJECT" "$INF_ENV"
printf '\033[1;36m======================================================================\033[0m\n'

case "$MODULE" in
  pwd|k7pwd)
    printf '\n\033[1;33m[k7pwd] Generating CSPRNG secrets in Alpine guest (/dev/urandom + openssl):\033[0m\n'
    printf '  urandom-alnum-sym (24c) : '
    LC_ALL=C tr -dc 'A-Za-z0-9!@#$%' < /dev/urandom | head -c 24; echo
    if command -v openssl >/dev/null 2>&1; then
      printf '  openssl-base64 (16B)    : '
      openssl rand -base64 16
      printf '  openssl-hex (32B)       : '
      openssl rand -hex 32
    fi
    printf '  prefixed-api-key        : k7_%s_%s\n' "$INF_ENV" "$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32)"
    ;;
  env|k7env)
    printf '\n\033[1;33m[k7env] Per-Project Infisical & Mistral Free-Tier Scope:\033[0m\n'
    printf '  Account Email        : %s@webomage.com\n' "$PROJECT"
    printf '  Infisical Secret Key : MISTRAL_API_KEY_%s\n' "$UPPER_PROJ"
    printf '  Private Vault Scope  : w0m-web/projects/%s/vault (cross-project access: DENIED)\n' "$PROJECT"
    printf '  Host Proxy Cmd       : infisical run --env=%s --silent -- k7 run env\n' "$INF_ENV"
    ;;
  kb|k7kb)
    printf '\n\033[1;33m[k7kb] Knowledge Base Search, Obsidian Vaults & Semantic Data Mining:\033[0m\n'
    printf '  Corpus               : 1,938 docs / 18,489 chunks (SQLite FTS5 BM25 + 128-dim SVD Cosine)\n'
    printf '  Project Vault        : w0m-web/projects/%s/vault (r2://%s/, cross_project_access=false)\n' "$PROJECT" "$PROJECT"
    printf '  Host CLI             : k7kb search "mistral obsidian" | k7kb vaults | k7kb datamine\n'
    ;;
  seo-geo|seo|geo)
    printf '\n\033[1;33m[k7kb seo-geo] Crew SEO, GEO (Generative Engine Optimization) & Security Scanner:\033[0m\n'
    printf '  SEO Pillar (100pt)   : <title>, <meta description>, rel=canonical, OpenGraph, <h1>, robots.txt, sitemap.xml\n'
    printf '  GEO Pillar (100pt)   : /llms.txt index, Schema.org JSON-LD entity graph, GPTBot/ClaudeBot/Perplexity/Mistral access\n'
    printf '  Security (100pt)     : HTTPS/TLS, HSTS, CSP, X-Content-Type-Options: nosniff, X-Frame-Options, /.well-known/security.txt\n'
    printf '  Host CLI             : k7kb seo-geo https://webomage.com\n'
    ;;
  obs|analytics)
    printf '\n\033[1;33m[k7kb analytics] Multi-Channel Analytics & Enterprise Observability Packages:\033[0m\n'
    printf '  Product/Marketing    : MS Clarity, Google Analytics 4 (GA4), Meta Business/Pixel, LinkedIn, PostHog, Tinybird/CF\n'
    printf '  Enterprise APM/SIEM  : Sentry Enterprise, Datadog APM/RUM/Logs, Grafana Cloud (Loki/Tempo/Mimir), OpenTelemetry + PagerDuty\n'
    printf '  Host CLI             : k7kb analytics --project %s --probe\n' "$PROJECT"
    ;;
  acp|sessions)
    printf '\n\033[1;33m[k7kb acp] Same-Host Agent Session Discovery & ACP Protocol (2025-03-26):\033[0m\n'
    printf '  Discovered Families  : w0m-agent-tree (~/.w0m/work/*), Orca Desktop/CLI, Antigravity, Claude Code, Codex, vibe-acp\n'
    printf '  ACP JSON-RPC Methods : initialize, session/new, session/load, session/prompt, session/cancel, host/discover\n'
    printf '  Host CLI             : k7kb acp --discover | k7kb acp --method session/new --project %s\n' "$PROJECT"
    ;;
  *)
    printf '\n\033[1;32m[@k7 & @wom Crew Unified Module Registry]\033[0m\n'
    printf '  [1]  env     (k7env)          - Infisical profiles (%s) & Cloud/AI Free-Tier proxies\n' "$INF_ENV"
    printf '  [2]  pwd     (k7pwd)          - CSPRNG password & token generator (/dev/urandom, openssl)\n'
    printf '  [3]  vm      (k7d)            - Tart VMs, containers & LinuxOnTab WASM sandboxes\n'
    printf '  [4]  k8s     (k7s)            - Kubernetes cluster control plane (k9s Rust port)\n'
    printf '  [5]  cloud   (k7c)            - Cloud infra tree & Mermaid/Graphviz diagrammer\n'
    printf '  [6]  llm     (k7llm)          - Multi-agent A2A & LLM router parity TUI\n'
    printf '  [7]  spec    (k7spec)         - Unified AI rules, OpenSpec & MCP generator\n'
    printf '  [8]  sol     (k7sol)          - Solana wallet, SPL token & Anchor IDL TUI\n'
    printf '  [9]  tg      (k7tg)           - Telegram automation & unified audit logs\n'
    printf '  [10] kb      (k7kb)           - Knowledge Base search, Obsidian vaults & semantic data mining\n'
    printf '  [11] seo-geo (k7kb seo-geo)   - Crew SEO, GEO (AI Search) & Perimeter Security scanner\n'
    printf '  [12] obs     (k7kb analytics) - Sentry, Datadog, Grafana, OTel, Clarity, GA4, Meta, LinkedIn, PostHog, Tinybird\n'
    printf '  [13] acp     (k7kb acp)       - Same-host agent session discovery & ACP JSON-RPC 2.0 manager\n'
    ;;
esac
