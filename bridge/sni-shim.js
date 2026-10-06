/*
 * sni-shim.js — loaded first inside each Hutch tracker page.
 *
 * Hutch talks to SNI over ws://host:23074 using the usb2snes JSON protocol.
 * When this page is hosted by the unified app, we swap window.WebSocket for a
 * look-alike that answers those requests from window.AlttpBridge (in the
 * parent page) instead of the network. Anything that isn't an SNI-style
 * connection still gets a real WebSocket.
 *
 * Opcodes handled: DeviceList, Attach, Info, Name, GetAddress.
 */
(function () {
  'use strict';
  var RealWS = window.WebSocket;

  function findBridge() {
    var seen = [];
    var w = window;
    for (var depth = 0; depth < 6 && w && seen.indexOf(w) < 0; depth++) {
      seen.push(w);
      try { if (w.AlttpBridge) return w.AlttpBridge; } catch (e) {}
      try { w = (w.parent && w.parent !== w) ? w.parent : w.opener; } catch (e) { w = null; }
    }
    return null;
  }
  if (!findBridge()) return; // standalone use: leave the real WebSocket alone

  function isSniUrl(url) { return /^wss?:\/\/[^/]+:(23074|8080|23070)\b/.test(String(url)); }

  function BridgeSocket(url) {
    this.url = String(url);
    this.readyState = 0;
    this.binaryType = 'blob';
    this.protocol = '';
    this.extensions = '';
    this.bufferedAmount = 0;
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
    this._attached = false;
    this._listeners = {};
    var self = this;
    setTimeout(function () {
      if (self.readyState !== 0) return;
      self.readyState = 1;
      self._fire('open', {});
    }, 0);
  }
  BridgeSocket.CONNECTING = 0; BridgeSocket.OPEN = 1; BridgeSocket.CLOSING = 2; BridgeSocket.CLOSED = 3;
  BridgeSocket.prototype.CONNECTING = 0; BridgeSocket.prototype.OPEN = 1;
  BridgeSocket.prototype.CLOSING = 2; BridgeSocket.prototype.CLOSED = 3;

  BridgeSocket.prototype.addEventListener = function (type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  };
  BridgeSocket.prototype.removeEventListener = function (type, fn) {
    var l = this._listeners[type]; if (!l) return;
    var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
  };
  BridgeSocket.prototype._fire = function (type, ev) {
    ev.type = type; ev.target = this;
    var h = this['on' + type];
    try { if (h) h.call(this, ev); } catch (e) { console.error(e); }
    (this._listeners[type] || []).slice().forEach(function (fn) {
      try { fn.call(this, ev); } catch (e) { console.error(e); }
    }, this);
  };
  BridgeSocket.prototype._reply = function (data) {
    var self = this;
    // Async, in order — same as a real socket.
    setTimeout(function () {
      if (self.readyState !== 1) return;
      self._fire('message', { data: data });
    }, 0);
  };
  BridgeSocket.prototype._json = function (obj) { this._reply(JSON.stringify(obj)); };

  BridgeSocket.prototype.send = function (msg) {
    if (this.readyState !== 1) return;
    var req;
    try { req = JSON.parse(msg); } catch (e) { return; }
    var bridge = findBridge();
    var ready = !!(bridge && bridge.ready());
    switch (req.Opcode) {
      case 'DeviceList':
        this._json({ Results: ready ? [bridge.deviceName] : [] });
        break;
      case 'Attach':
        this._attached = ready;
        break;
      case 'Info':
        this._json({ Results: ['1.0', 'EmulatorJS', 'ALTTP', 'NO_FILE_CMD', 'NO_CONTROL_CMD'] });
        break;
      case 'Name':
        break;
      case 'GetAddress': {
        var ops = req.Operands || [];
        for (var i = 0; i + 1 < ops.length; i += 2) {
          var addr = parseInt(ops[i], 16), len = parseInt(ops[i + 1], 16);
          var src = ready ? bridge.read(addr, len) : null;
          // Build the ArrayBuffer in THIS window's realm so the tracker's
          // `event.data instanceof ArrayBuffer` check passes.
          var out = new Uint8Array(len);
          if (src) for (var k = 0; k < len; k++) out[k] = src[k];
          this._reply(this.binaryType === 'arraybuffer' ? out.buffer : new Blob([out]));
        }
        break;
      }
      default:
        break; // PutAddress etc. — not needed for tracking
    }
  };

  BridgeSocket.prototype.close = function () {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    var self = this;
    setTimeout(function () { self._fire('close', { code: 1000, reason: '', wasClean: true }); }, 0);
  };

  function ShimWebSocket(url, protocols) {
    if (isSniUrl(url)) return new BridgeSocket(url);
    return protocols === undefined ? new RealWS(url) : new RealWS(url, protocols);
  }
  ShimWebSocket.CONNECTING = 0; ShimWebSocket.OPEN = 1; ShimWebSocket.CLOSING = 2; ShimWebSocket.CLOSED = 3;
  ShimWebSocket.prototype = RealWS.prototype;
  window.WebSocket = ShimWebSocket;
  window.__UNIFIED_APP__ = true;
})();
