# Package recipe for: k7
# @k7 Unified Operator Cockpit & 10-Module Suite (k7, k7kb, k7env, k7pwd, k7c, k7spec, k7d, k7s, k7llm, k7tg, k7sol) for LinuxOnTab WASM.
PKG_NAME=k7
PKG_VERSION=0.1.0
PKG_URL=https://github.com/webomage/linuxontab/releases/download/v0.1.0/k7-0.1.0.tar.gz
PKG_DESC="k7 Unified Operator Cockpit & 10-Module TUI/CLI Suite (kb, env, pwd, cloud, spec, vm, k8s, llm, notify, sol) for LinuxOnTab WASM"
PKG_DEPENDS="curl jq zsh python3"

pkg_build() {
    mkdir -p "$PREFIX/bin" "$PREFIX/lib/k7" "$PREFIX/share/doc/k7"
    cp "$SRC/k7.sh" "$PREFIX/lib/k7/k7.sh"
    chmod 0755 "$PREFIX/lib/k7/k7.sh"
    for bin in k7 k7kb k7env k7pwd k7c k7spec k7d k7s k7llm k7tg k7sol; do
        cat > "$PREFIX/bin/$bin" <<EOF
#!/usr/bin/zsh
exec /usr/local/bin/zsh /usr/local/lib/k7/k7.sh "$bin" "\$@"
EOF
        chmod 0755 "$PREFIX/bin/$bin"
    done
}
