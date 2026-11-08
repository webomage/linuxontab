# Package recipe for: orca
# Orca CLI & Agent Client Protocol (ACP 2025-03-26) worktree/session manager for LinuxOnTab WASM.
PKG_NAME=orca
PKG_VERSION=1.4.214
PKG_URL=https://github.com/stablyai/orca/archive/refs/tags/v1.4.214.tar.gz
PKG_DESC="Orca CLI & Agent Client Protocol (ACP 2025-03-26) multi-agent worktree, terminal, and @k7 session orchestrator"
PKG_DEPENDS="curl jq zsh"

pkg_build() {
    mkdir -p "$PREFIX/bin" "$PREFIX/lib/orca" "$PREFIX/share/doc/orca"
    cp "$SRC/orca.sh" "$PREFIX/lib/orca/orca.sh"
    chmod 0755 "$PREFIX/lib/orca/orca.sh"
    cat > "$PREFIX/bin/orca" <<'EOF'
#!/usr/bin/zsh
exec /usr/local/bin/zsh /usr/local/lib/orca/orca.sh "$@"
EOF
    chmod 0755 "$PREFIX/bin/orca"
}
