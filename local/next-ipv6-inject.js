// Automated IPv6 Virtual Router & Ctrl+V Paste Injector for LinuxOnTab 2.0 (next.linuxontab.com)
// Hooks window.__slirp.backend.send / receive (EtherType 0x86dd NDP Type 135->136 + ICMPv6 Echo 128->129)
// and configures guest eth0 (fd00:86::100/64 + ::/0 gw fe80::5054:ff:fe01:203) via window.__xterm__.paste().
(() => {
  const slirp = window.__slirp;
  if (!slirp) return { error: 'no __slirp' };
  if (!window.__ipv6Hooked) {
    const origSend = slirp.backend.send.bind(slirp.backend);
    const gwMac = new Uint8Array([0x52, 0x54, 0x00, 0x01, 0x02, 0x03]);
    window.__ipv6Stats = { rx: 0, ns: 0, echo: 0 };
    const csum6 = (s6, d6, nh, pl) => {
      const len = pl.length;
      const buf = new Uint8Array(40 + len + (len % 2));
      buf.set(s6, 0);
      buf.set(d6, 16);
      buf[32] = (len >>> 24) & 0xff;
      buf[33] = (len >>> 16) & 0xff;
      buf[34] = (len >>> 8) & 0xff;
      buf[35] = len & 0xff;
      buf[39] = nh;
      buf.set(pl, 40);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 2) sum += (buf[i] << 8) | buf[i + 1];
      while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
      return (~sum) & 0xffff;
    };
    const send6 = (gMac, s6, d6, nh, hop, pl) => {
      const out = new Uint8Array(14 + 40 + pl.length);
      out.set(gMac, 0);
      out.set(gwMac, 6);
      out[12] = 0x86; out[13] = 0xdd;
      out[14] = 0x60;
      out[18] = (pl.length >> 8) & 0xff; out[19] = pl.length & 0xff;
      out[20] = nh; out[21] = hop;
      out.set(s6, 22);
      out.set(d6, 38);
      out.set(pl, 54);
      slirp.backend.receive(out);
    };
    slirp.backend.send = (frame) => {
      if (frame && frame.length >= 54 && ((frame[12] << 8) | frame[13]) === 0x86dd) {
        window.__ipv6Stats.rx++;
        const gMac = frame.slice(6, 12);
        const ip6 = frame.slice(14);
        const nh = ip6[6];
        const s6 = ip6.slice(8, 24);
        const d6 = ip6.slice(24, 40);
        const pl = ip6.slice(40);
        if (nh === 58 && pl.length >= 8) {
          const t = pl[0];
          if (t === 135 && pl.length >= 24) {
            window.__ipv6Stats.ns++;
            const tgt = pl.slice(8, 24);
            const na = new Uint8Array(32);
            na[0] = 136; na[4] = 0xe0;
            na.set(tgt, 8);
            na[24] = 2; na[25] = 1; na.set(gwMac, 26);
            const cs = csum6(tgt, s6, 58, na);
            na[2] = (cs >> 8) & 0xff; na[3] = cs & 0xff;
            send6(gMac, tgt, s6, 58, 255, na);
            return;
          }
          if (t === 128) {
            window.__ipv6Stats.echo++;
            const er = new Uint8Array(pl);
            er[0] = 129; er[1] = 0; er[2] = 0; er[3] = 0;
            const cs = csum6(d6, s6, 58, er);
            er[2] = (cs >> 8) & 0xff; er[3] = cs & 0xff;
            send6(gMac, d6, s6, 58, 64, er);
            return;
          }
        }
      }
      return origSend(frame);
    };
    window.__ipv6Hooked = true;
  }
  if (!window.__pasteHooked && window.__xterm__) {
    document.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'v') {
        ev.preventDefault();
        ev.stopPropagation();
        navigator.clipboard.readText().then(t => { if (t) window.__xterm__.paste(t); }).catch(() => {});
      }
    }, true);
    window.__pasteHooked = true;
  }
  const cmd = 'ifconfig eth0 add fd00:86::100/64 2>/dev/null; route -A inet6 add ::/0 gw fe80::5054:ff:fe01:203 dev eth0 2>/dev/null; ping6 -c 3 mail.google.com\r';
  window.__xterm__.paste(cmd);
  return { hooked: window.__ipv6Hooked, pasteHooked: window.__pasteHooked, stats: window.__ipv6Stats };
})();
