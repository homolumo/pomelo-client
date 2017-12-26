const { setTimeout } = require('timers');

const events = require('events');
const util = require('util');
const Protocol = require('pomelo-protocol');
const Protobuf = require('./pomelo-protobuf/protobuf');
const WebSocket = require('ws');

const { Package, Message } = Protocol;

const CODE_OK = 200;
const CODE_OLD_CLIENT = 501;

class PomeloClient extends events.EventEmitter {
  constructor() {
    super();

    this.socket = null;
    // heartbeat
    this.heartbeatInterval = 0;
    this.heartbeatTimeout = 0;
    this.heartbeatId = null;
    this.heartbeatTimeoutId = null;

    this.handles = {};
    // handshake
    this.handles[Package.TYPE_HANDSHAKE] = (_data) => {
      const data = JSON.parse(Protocol.strdecode(_data));
      if (data.code === CODE_OLD_CLIENT) {
        this.emit('error', 'the client version is too old');
        return;
      }

      if (data.code !== CODE_OK) {
        this.emit('error', 'handshake failed');
        return;
      }

      // heartbeat
      const { heartbeat, dict, protos } = data.sys;
      if (heartbeat) {
        this.heartbeatInterval = heartbeat * 1000;
        this.heartbeatTimeout = this.heartbeatInterval * 2;
      }

      // dict
      if (dict) {
        this.useDict = true;
        for (const [route, code] of Object.entries(dict)) {
          this.dictCode2Route[code] = route;
          this.dictRoute2Code[route] = code;
        }
      }

      // protobuf
      if (protos) {
        this.protobuf = new Protobuf();
        this.useProtos = true;
        this.protos.version = protos.protoVersion || 0;
        this.protos.server = protos.server;
        this.protos.client = protos.client;
        this.protobuf.init({
          encoderProtos: this.protos.client,
          decoderProtos: this.protos.server,
        });
      }

      if (typeof this.handshakeCallback === 'function') {
        this.handshakeCallback(data);
      }

      // ack
      this.send(Package.encode(Package.TYPE_HANDSHAKE_ACK));

      this.emit('onInit', this.socket);
    };

    // heartbeat
    this.handles[Package.TYPE_HEARTBEAT] = () => {
      // clear heartbeat timeout fn
      if (this.heartbeatTimeoutId) {
        clearTimeout(this.heartbeatTimeoutId);
        this.heartbeatTimeoutId = null;
      }

      if (this.heartbeatId) {
        return;
      }

      // send heartbeat packet
      this.heartbeatId = setTimeout(() => {
        this.heartbeatId = null;
        this.send(Package.encode(Package.TYPE_HEARTBEAT));
        // emit heartbeat timeout fn
        this.heartbeatTimeoutId = setTimeout(() => {
          this.emit('heartbeatTimeout');
          this.disconnect(1001);
        }, this.heartbeatTimeout + 500 /* delay */);
      }, this.heartbeatInterval);
    };

    // data message, server push/client request
    this.handles[Package.TYPE_DATA] = (data) => {
      const msg = Message.decode(data);

      // dict
      if (msg.compressRoute) {
        const dictCode2Route = this.dictCode2Route[msg.route];
        if (!dictCode2Route) {
          util.log(`not found dict[${msg.route}]`);
          return;
        }
        msg.route = dictCode2Route;
      }

      // if client request, we need find route by requestId on client
      const requestId = msg.id;
      if (requestId) {
        msg.route = this.requestRoutes[requestId];
        delete this.requestRoutes[requestId];
      }

      // protobuf
      let body;
      if (this.useProtos && this.protos.server[msg.route]) {
        body = this.protobuf.decode(msg.route, msg.body);
      } else {
        body = JSON.parse(Protocol.strdecode(msg.body));
      }

      if (!requestId) {
        try {
          this.emit(msg.route, body);
        } finally {
          this.emit('*', { route: msg.route, body });
        }
        return;
      }

      // request message
      const requestRouteCallback = this.requestRouteCallbacks[requestId];
      if (!requestRouteCallback) {
        return;
      }
      delete this.requestRouteCallbacks[requestId];
      requestRouteCallback.call(null, body);
    };

    // kick
    this.handles[Package.TYPE_KICK] = (data) => {
      this.emit('onKick', JSON.parse(Protocol.strdecode(data)));
    };
  }

  async init(params, timeout = 10000) {
    if (this.socket) {
      this.disconnect();
    }

    // request
    this.useCrypto = false;
    this.requestId = 0;
    this.requestRoutes = {};
    this.requestRouteCallbacks = {};

    // dict
    this.useDict = false;
    this.dictCode2Route = {};
    this.dictRoute2Code = {};

    // protobuf
    this.useProtos = false;
    this.protos = {};

    // handshake data
    this.handshakeBuffer = {
      sys: {
        protoVersion: 0,
      },
      user: {},
    };

    if (params.encrypt) {
      this.useCrypto = true;
      util.log('NO-IMPL');
    }

    const endpoint = `ws://${params.host}:${params.port}`;
    const socket = new WebSocket(endpoint);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      const packet = Package.encode(
        Package.TYPE_HANDSHAKE,
        Protocol.strencode(JSON.stringify(this.handshakeBuffer)),
      );
      this.send(packet);
    };
    socket.onmessage = (event) => {
      const msg = Package.decode(event.data);
      if (Array.isArray(msg)) {
        for (let i = 0; i < msg.length; i += 1) {
          this.handles[msg[i].type](msg[i].body);
        }
      } else {
        this.handles[msg.type](msg.body);
      }
    };
    socket.onerror = (event) => {
      this.emit('io-error', event);
    };
    socket.onclose = (event) => {
      this.onDisconnect(event);
      this.emit('disconnect', event);
    };
    this.socket = socket;

    return Promise.race([
      new Promise((resolve) => {
        this.once('onInit', (res) => {
          resolve(res);
        });
      }),
      new Promise((resolve, error) => {
        setTimeout(() => {
          error(new Error('timeout'));
        }, timeout);
      }),
    ]);
  }

  send(packet) {
    try {
      this.socket.send(packet);
    } catch (e) {
      this.emit('io-error', e);
    }
  }

  async request(route, msg = {}, timeout = 10000) {
    if (!route) {
      throw new Error('request route must not be empty!');
    }

    this.requestId += 1;
    this.sendMessage(this.requestId, route, msg);
    this.requestRoutes[this.requestId] = route;
    return Promise.race([
      new Promise((resolve) => {
        this.requestRouteCallbacks[this.requestId] = (data) => {
          resolve(data);
        };
      }),
      new Promise((resolve, error) => {
        setTimeout(() => {
          delete this.requestRouteCallbacks[this.requestId];
          const err = new Error('timeout');
          err.msg = msg;
          err.route = route;
          error(err);
        }, timeout);
      }),
    ]);
  }

  notify(route, msg = {}) {
    return this.sendMessage(null, route, msg);
  }

  sendMessage(requestId, r, m) {
    if (this.useCrypto) {
      util.log('NO-IMPL');
    }

    // dict
    let compressRoute = false;
    let route = r;
    if (this.useDict && this.dictRoute2Code[r]) {
      route = this.dictRoute2Code[r];
      compressRoute = true;
    }

    // protobuf
    let msg;
    if (this.useProtos && this.protos.client[route]) {
      msg = this.protobuf.encode(route, m);
    } else {
      msg = Protocol.strencode(JSON.stringify(m));
    }

    const type = requestId ? Message.TYPE_REQUEST : Message.TYPE_NOTIFY;
    msg = Message.encode(requestId, type, compressRoute, route, msg);
    this.send(Package.encode(Package.TYPE_DATA, msg));
  }

  disconnect(code) {
    if (!this.socket) {
      return;
    }
    //   1000: 'normal',
    //   1001: 'going away',
    //   1002: 'protocol error',
    //   1003: 'unsupported data',
    //   1004: 'reserved',
    //   1005: 'reserved for extensions',
    //   1006: 'reserved for extensions',
    //   1007: 'inconsistent or invalid data',
    //   1008: 'policy violation',
    //   1009: 'message too big',
    //   1010: 'extension handshake missing',
    //   1011: 'an unexpected condition prevented the request from being fulfilled',
    //   1012: 'service restart',
    //   1013: 'try again later'
    this.socket.close(code || 1000);
    this.socket = null;
  }

  onDisconnect() {
    if (this.heartbeatId) {
      clearTimeout(this.heartbeatId);
      this.heartbeatId = null;
    }
    if (this.heartbeatTimeoutId) {
      clearTimeout(this.heartbeatTimeoutId);
      this.heartbeatTimeoutId = null;
    }
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emit('close', this);
  }
}

module.exports = PomeloClient;
