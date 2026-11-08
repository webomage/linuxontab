# Package recipe for: just
# webomage/just (1.59.0-w0m.1) command runner with #3773, #2684, #1500, and #1885 for LinuxOnTab WASM.
PKG_NAME=just
PKG_VERSION=1.59.0-w0m.1
PKG_URL=https://github.com/webomage/linuxontab/releases/download/v0.1.0/just-1.59.0-w0m.1.tar.gz
PKG_DESC="webomage/just (1.59.0 + w0m overlay: #3773 fmt header comments, #2684 multi-line docs, #1500 fallback --list, #1885 wildcard imports) for LinuxOnTab WASM"
PKG_DEPENDS="python3 zsh"

pkg_build() {
    mkdir -p "$PREFIX/bin" "$PREFIX/lib/just" "$PREFIX/share/doc/just"
    cp "$SRC/just.sh" "$PREFIX/lib/just/just.sh"
    chmod 0755 "$PREFIX/lib/just/just.sh"
    cat > "$PREFIX/bin/just" <<'EOF'
#!/usr/bin/zsh
exec /usr/local/bin/zsh /usr/local/lib/just/just.sh "$@"
EOF
    chmod 0755 "$PREFIX/bin/just"
}
