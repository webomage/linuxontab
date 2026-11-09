/**
 * Universal TabLinux Clipboard & Terminal Paste Bridge (`local/clipboard-bridge.js`).
 *
 * Eliminates terminal paste friction across all TabLinux surfaces:
 * 1. `next.linuxontab.com` (LinuxOnTab 2.0 WALI/WASM kernel with `window.lot_stdin_bytes(Uint8Array)` and `#terminal`)
 * 2. `linuxontab.com/shell/` (v86 + xterm.js with `window.sendGuestText` / `window.emulator.serial0_send`)
 * 3. `pip-shell.html` & `w0m-cp` / `w0m-ext` iframe embeddings (`postMessage({ type: "tablinux:paste", text })`)
 *
 * Features:
 * - Seamless `Ctrl+V`, `Ctrl+Shift+V`, `Cmd+V`, `Shift+Insert`, and browser `paste` event handling
 *   with a deduplication window so keydown + native `paste` never double-paste.
 * - Top-bar `paste` and `copy` buttons in `#bar` / `.topbar` with automatic injection if missing.
 * - Zero-permission fallback modal when `navigator.clipboard.readText()` is denied by browser/iframe policy.
 * - Chunked stdin streaming (`CHUNK_BYTES = 512`) so multi-line scripts never overflow the guest tty ring buffer.
 */
(function initTabLinuxClipboardBridge(globalScope) {
  if (globalScope.__tablinuxClipboardBridgeLoaded) {
    return;
  }
  globalScope.__tablinuxClipboardBridgeLoaded = true;

  var DEDUPE_WINDOW_MS = 180;
  var CHUNK_CHARS = 512;
  var lastPasteAt = 0;
  var lastPasteSignature = "";

  function normalizeTerminalPasteText(rawText, options) {
    var text = String(rawText == null ? "" : rawText);
    if (!text) return "";
    // Normalize CRLF -> LF so Linux shells don't receive stray ^M characters.
    var normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (options && options.appendNewline && !normalized.endsWith("\n")) {
      normalized += "\n";
    }
    return normalized;
  }

  function computePasteSignature(text) {
    return String(text.length) + ":" + text.slice(0, 48) + ":" + text.slice(-48);
  }

  function shouldDeduplicatePaste(text, nowMs) {
    var now = typeof nowMs === "number" ? nowMs : Date.now();
    var sig = computePasteSignature(text);
    if (sig === lastPasteSignature && now - lastPasteAt < DEDUPE_WINDOW_MS) {
      return true;
    }
    lastPasteAt = now;
    lastPasteSignature = sig;
    return false;
  }

  function writeStdinText(rawText, options) {
    var opts = options || {};
    var text = normalizeTerminalPasteText(rawText, opts);
    if (!text) return { ok: false, reason: "empty", bytesSent: 0 };

    if (!opts.skipDedupe && shouldDeduplicatePaste(text, opts.nowMs)) {
      return { ok: true, deduplicated: true, bytesSent: 0 };
    }

    var encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
    var bytes = encoder ? encoder.encode(text) : null;
    var byteLength = bytes ? bytes.byteLength : text.length;

    // 1. LinuxOnTab 2.0 WALI/WASM kernel hook (`window.lot_stdin_bytes`)
    if (typeof globalScope.lot_stdin_bytes === "function" && !globalScope.__lotStdinIsV86Shim) {
      try {
        for (var offset = 0; offset < text.length; offset += CHUNK_CHARS) {
          var slice = text.slice(offset, offset + CHUNK_CHARS);
          var chunkBytes = encoder ? encoder.encode(slice) : Uint8Array.from(slice, function (c) { return c.charCodeAt(0); });
          globalScope.lot_stdin_bytes(chunkBytes);
        }
        updatePasteStatus("pasted " + byteLength + " B", "ok");
        return { ok: true, sink: "lot_stdin_bytes", bytesSent: byteLength };
      } catch (err) {
        updatePasteStatus("paste error: " + (err && err.message ? err.message : String(err)), "err");
      }
    }

    // 2. v86 shell guest helper (`window.sendGuestText` or `window.emulator.serial0_send`)
    if (typeof globalScope.sendGuestText === "function") {
      try {
        globalScope.sendGuestText(text);
        updatePasteStatus("pasted " + byteLength + " B", "ok");
        return { ok: true, sink: "sendGuestText", bytesSent: byteLength };
      } catch (_) {}
    }

    if (globalScope.emulator && typeof globalScope.emulator.serial0_send === "function") {
      try {
        for (var i = 0; i < text.length; i++) {
          globalScope.emulator.serial0_send(text[i]);
        }
        updatePasteStatus("pasted " + byteLength + " B", "ok");
        return { ok: true, sink: "serial0_send", bytesSent: byteLength };
      } catch (_) {}
    }

    // 3. xterm.js instance fallback (`window.term.paste`)
    if (globalScope.term && typeof globalScope.term.paste === "function") {
      try {
        globalScope.term.paste(text);
        updatePasteStatus("pasted " + byteLength + " B", "ok");
        return { ok: true, sink: "xterm.paste", bytesSent: byteLength };
      } catch (_) {}
    }

    // 4. Parent wrapper (`pip-shell.html` or `w0m-cp` host page) forwarding into child iframe
    if (typeof document !== "undefined") {
      var frame = document.getElementById("frame") || document.querySelector("iframe");
      if (frame && frame.contentWindow) {
        try {
          frame.contentWindow.postMessage(
            { type: "tablinux:paste", text: text, source: "tablinux-clipboard-bridge" },
            "*"
          );
          updatePasteStatus("forwarded " + byteLength + " B to frame", "ok");
          return { ok: true, sink: "iframe.postMessage", bytesSent: byteLength };
        } catch (_) {}
      }
    }

    return { ok: false, reason: "no_active_terminal_sink", bytesSent: 0 };
  }

  // Provide unified `window.lot_stdin_bytes(Uint8Array | string)` on v86 shells too
  if (typeof globalScope.lot_stdin_bytes !== "function") {
    globalScope.__lotStdinIsV86Shim = true;
    globalScope.lot_stdin_bytes = function (input) {
      var str = "";
      if (typeof input === "string") {
        str = input;
      } else if (input instanceof Uint8Array || ArrayBuffer.isView(input)) {
        str = new TextDecoder().decode(input);
      } else if (Array.isArray(input)) {
        str = new TextDecoder().decode(new Uint8Array(input));
      }
      return writeStdinText(str, { skipDedupe: true });
    };
  }

  function updatePasteStatus(msg, cls) {
    if (typeof document === "undefined") return;
    var badge = document.getElementById("lot-paste-status") || document.getElementById("status");
    if (!badge) return;
    badge.textContent = msg;
    if (badge.id === "lot-paste-status") {
      badge.style.color = cls === "err" ? "#f87171" : "#4ade80";
      clearTimeout(badge.__clearTimer);
      badge.__clearTimer = setTimeout(function () {
        badge.textContent = "";
      }, 2800);
    }
  }

  function getSelectedTerminalText() {
    if (globalScope.term && typeof globalScope.term.hasSelection === "function" && globalScope.term.hasSelection()) {
      return globalScope.term.getSelection();
    }
    if (typeof globalScope.getSelection === "function") {
      var sel = globalScope.getSelection();
      var txt = sel ? sel.toString() : "";
      if (txt) return txt;
    }
    if (typeof document !== "undefined") {
      var termPre = document.getElementById("terminal");
      if (termPre && termPre.textContent) {
        return termPre.textContent.slice(-4096);
      }
    }
    return "";
  }

  function openFallbackPasteModal(onSubmit) {
    if (typeof document === "undefined") return;
    var existing = document.getElementById("lot-paste-modal");
    if (existing) existing.remove();

    var backdrop = document.createElement("div");
    backdrop.id = "lot-paste-modal";
    backdrop.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,0.65);" +
      "display:flex;align-items:center;justify-content:center;font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e2e8f0;";

    var card = document.createElement("div");
    card.style.cssText =
      "background:#14181f;border:1px solid #334155;border-radius:8px;width:min(540px,92vw);" +
      "padding:14px 16px;display:flex;flex-direction:column;gap:10px;box-shadow:0 16px 48px rgba(0,0,0,0.7);";

    var title = document.createElement("div");
    title.style.cssText = "display:flex;justify-content:space-between;align-items:center;font-weight:600;color:#4ade80;";
    title.textContent = "Paste into TabLinux Terminal (Ctrl+V / Multi-line supported)";

    var area = document.createElement("textarea");
    area.id = "lot-paste-textarea";
    area.rows = 6;
    area.placeholder = "Press Ctrl+V / Cmd+V here, then click Send to Terminal (or press Ctrl+Enter)...";
    area.style.cssText =
      "width:100%;box-sizing:border-box;background:#0b0d10;color:#e2e8f0;border:1px solid #3a424d;" +
      "border-radius:6px;padding:8px 10px;font:inherit;resize:vertical;outline:none;";

    var row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;";

    var nlLabel = document.createElement("label");
    nlLabel.style.cssText = "display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#94a3b8;cursor:pointer;";
    var nlCheck = document.createElement("input");
    nlCheck.type = "checkbox";
    nlCheck.checked = false;
    var nlSpan = document.createElement("span");
    nlSpan.textContent = "Run immediately (append Enter)";
    nlLabel.appendChild(nlCheck);
    nlLabel.appendChild(nlSpan);

    var btnGroup = document.createElement("div");
    btnGroup.style.cssText = "display:flex;gap:8px;";

    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText =
      "background:#222830;color:#cbd5e1;border:1px solid #3a424d;border-radius:5px;padding:5px 12px;font:inherit;cursor:pointer;";

    var sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.textContent = "Send to Terminal";
    sendBtn.style.cssText =
      "background:#166534;color:#dcfce7;border:1px solid #22c55e;border-radius:5px;padding:5px 14px;font:inherit;cursor:pointer;font-weight:600;";

    function close() {
      try { backdrop.remove(); } catch (_) {}
    }

    function submit() {
      var val = area.value;
      close();
      if (val) {
        onSubmit(val, { appendNewline: nlCheck.checked, skipDedupe: true });
      }
    }

    cancelBtn.addEventListener("click", close);
    sendBtn.addEventListener("click", submit);
    backdrop.addEventListener("click", function (ev) {
      if (ev.target === backdrop) close();
    });
    area.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        close();
      } else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        submit();
      }
    });

    btnGroup.appendChild(cancelBtn);
    btnGroup.appendChild(sendBtn);
    row.appendChild(nlLabel);
    row.appendChild(btnGroup);
    card.appendChild(title);
    card.appendChild(area);
    card.appendChild(row);
    backdrop.appendChild(card);
    (document.body || document.documentElement).appendChild(backdrop);
    setTimeout(function () {
      try { area.focus(); } catch (_) {}
    }, 20);
  }

  async function pasteFromClipboardOrPrompt(options) {
    var opts = options || {};
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.readText === "function" &&
      !opts.forceModal
    ) {
      try {
        var clipText = await navigator.clipboard.readText();
        if (clipText) {
          return writeStdinText(clipText, opts);
        }
      } catch (_) {
        // Fall through to modal when clipboard-read permission is denied
      }
    }
    openFallbackPasteModal(function (text, modalOpts) {
      writeStdinText(text, Object.assign({}, opts, modalOpts));
    });
    return { ok: true, modalOpened: true };
  }

  async function copySelectionToClipboard() {
    var txt = getSelectedTerminalText();
    if (!txt) {
      updatePasteStatus("select text first", "err");
      return { ok: false, reason: "no_selection" };
    }
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(txt);
        updatePasteStatus("copied " + txt.length + " chars", "ok");
        return { ok: true, charsCopied: txt.length };
      } catch (_) {}
    }
    return { ok: false, reason: "clipboard_unavailable" };
  }

  function isEditableTarget(target) {
    if (!target || typeof target !== "object") return false;
    var tag = String(target.tagName || "").toUpperCase();
    // Allow xterm's internal helper textarea (`.xterm-helper-textarea`) to trigger terminal paste!
    var cls = String(target.className || "");
    if (cls.indexOf("xterm-helper-textarea") !== -1) return false;
    if (target.id === "lot-paste-textarea") return true;
    return tag === "INPUT" || tag === "TEXTAREA" || Boolean(target.isContentEditable);
  }

  function installDomListeners() {
    if (typeof window === "undefined" || typeof document === "undefined") return;

    // 1. Browser `paste` event (works without permission prompts on Ctrl+V / Ctrl+Shift+V / Right-click -> Paste)
    window.addEventListener(
      "paste",
      function (ev) {
        if (isEditableTarget(ev.target)) return;
        var clip = ev.clipboardData || window.clipboardData;
        var text = clip && typeof clip.getData === "function" ? clip.getData("text/plain") : "";
        if (text) {
          ev.preventDefault();
          ev.stopPropagation();
          writeStdinText(text);
        }
      },
      true
    );

    // 2. Keyboard fallback for environments where `paste` event doesn't fire on `<pre id="terminal">`
    window.addEventListener(
      "keydown",
      function (ev) {
        if (isEditableTarget(ev.target)) return;
        var mod = ev.ctrlKey || ev.metaKey;
        var key = String(ev.key || "").toLowerCase();
        var isPasteShortcut =
          (mod && key === "v") || (ev.shiftKey && ev.key === "Insert");
        if (!isPasteShortcut) return;

        // Wait 35ms for native `paste` event (zero-permission); if it didn't fire, read navigator.clipboard
        var triggeredAt = Date.now();
        setTimeout(function () {
          if (lastPasteAt >= triggeredAt) return;
          if (
            typeof navigator !== "undefined" &&
            navigator.clipboard &&
            typeof navigator.clipboard.readText === "function"
          ) {
            navigator.clipboard
              .readText()
              .then(function (t) {
                if (t) writeStdinText(t);
              })
              .catch(function () {});
          }
        }, 35);
      },
      true
    );

    // 3. Cross-window postMessage bridge (`tablinux:paste`, `tablinux:stdin`, `tablinux:copy`)
    window.addEventListener("message", function (ev) {
      var data = ev && ev.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "tablinux:paste" || data.type === "tablinux:stdin") {
        var payload = typeof data.text === "string" ? data.text : typeof data.data === "string" ? data.data : "";
        if (payload) {
          var res = writeStdinText(payload, {
            appendNewline: Boolean(data.appendNewline),
            skipDedupe: true,
          });
          try {
            if (ev.source && typeof ev.source.postMessage === "function") {
              ev.source.postMessage(
                {
                  type: "tablinux:paste:ack",
                  ok: res.ok,
                  bytesSent: res.bytesSent,
                  sink: res.sink || null,
                },
                "*"
              );
            }
          } catch (_) {}
        }
      }
    });

    // 4. Inject top-bar `paste` and `copy` controls if `#bar` or `.topbar` is present
    function ensureToolbarButtons() {
      var bar = document.getElementById("bar") || document.querySelector(".topbar");
      if (!bar) return;
      if (!document.getElementById("lot-paste-btn")) {
        var pasteBtn = document.createElement("button");
        pasteBtn.id = "lot-paste-btn";
        pasteBtn.type = "button";
        pasteBtn.className = bar.classList && bar.classList.contains("topbar") ? "btn" : "";
        pasteBtn.textContent = "paste";
        pasteBtn.title = "Paste clipboard into terminal (Ctrl+V / Ctrl+Shift+V; Shift+Click for multi-line box)";
        pasteBtn.addEventListener("click", function (ev) {
          pasteFromClipboardOrPrompt({ forceModal: Boolean(ev.shiftKey) });
        });

        var copyBtn = document.createElement("button");
        copyBtn.id = "lot-copy-btn";
        copyBtn.type = "button";
        copyBtn.className = bar.classList && bar.classList.contains("topbar") ? "btn" : "";
        copyBtn.textContent = "copy";
        copyBtn.title = "Copy selected terminal text to clipboard";
        copyBtn.addEventListener("click", function () {
          copySelectionToClipboard();
        });

        var statusSpan = document.createElement("span");
        statusSpan.id = "lot-paste-status";
        statusSpan.style.cssText = "font-size:11px;color:#4ade80;";

        var anchor =
          document.getElementById("terminal") && document.getElementById("terminal").tagName === "BUTTON"
            ? document.getElementById("terminal")
            : document.getElementById("status") || null;

        if (anchor && anchor.parentNode === bar) {
          bar.insertBefore(pasteBtn, anchor.nextSibling);
          bar.insertBefore(copyBtn, pasteBtn.nextSibling);
          bar.insertBefore(statusSpan, copyBtn.nextSibling);
        } else {
          bar.appendChild(pasteBtn);
          bar.appendChild(copyBtn);
          bar.appendChild(statusSpan);
        }
      }
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", ensureToolbarButtons);
    } else {
      ensureToolbarButtons();
    }
  }

  installDomListeners();

  globalScope.TabLinuxClipboard = {
    normalizeTerminalPasteText: normalizeTerminalPasteText,
    writeStdinText: writeStdinText,
    pasteFromClipboardOrPrompt: pasteFromClipboardOrPrompt,
    copySelectionToClipboard: copySelectionToClipboard,
    openFallbackPasteModal: openFallbackPasteModal,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = globalScope.TabLinuxClipboard;
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this);
