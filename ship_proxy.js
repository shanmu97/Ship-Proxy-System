"use strict";
require('dotenv').config();
const http = require("http");
const net = require("net");
const { EventEmitter } = require("events");
const {
  MessageType,
  FrameDecoder,
  MessageSendQueue,
} = require("./protocol");

const PROXY_PORT = Number(process.env.SHIP_PROXY_PORT) || 8080;
const OFFSHORE_HOST = process.env.OFFSHORE_HOST;
const OFFSHORE_PORT =  Number(process.env.OFFSHORE_PORT) || 9999;


function serializeHttpRequest(req, body) {
  const method = req.method;
  const path = req.url || "/";
  const version = `HTTP/${req.httpVersion}`;
  const startLine = `${method} ${path} ${version}`;
  const headers = { ...req.headers };
  if (!headers["host"]) {
    if (req.headers[":authority"]) {
      headers["host"] = req.headers[":authority"];
    }
  }
  if (body && body.length > 0) {
    headers["content-length"] = Buffer.byteLength(body);
    delete headers["transfer-encoding"];
  } else {
    headers["content-length"] = "0";
    delete headers["transfer-encoding"];
  }
  const headerLines = [];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    
    if (Array.isArray(value)) {
      for (const v of value) {
        headerLines.push(`${key}: ${v}`);
      }
    } else {
      headerLines.push(`${key}: ${value}`);
    }
  }

  const head = startLine + "\r\n" + headerLines.join("\r\n") + "\r\n\r\n";
  return Buffer.concat([Buffer.from(head, "utf8"), body || Buffer.alloc(0)]);
}

function parseRawHttpResponse(buf) {
  const text = buf.toString("utf8");
  const sep = "\r\n\r\n";
  const idx = text.indexOf(sep);
  const head = idx >= 0 ? text.slice(0, idx) : text;
  const body = idx >= 0 ? Buffer.from(text.slice(idx + sep.length), "utf8") : Buffer.alloc(0);
  const lines = head.split("\r\n");
  const [statusLine, ...headerLines] = lines;
  const m = /^HTTP\/\d\.\d\s+(\d{3})\s*(.*)$/.exec(statusLine);
  const statusCode = m ? Number(m[1]) : 502;
  const statusMessage = m ? m[2] : "Bad Gateway";
  const headers = {};
  for (const line of headerLines) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (headers[k] !== undefined) {
      headers[k] = Array.isArray(headers[k]) ? [...headers[k], v] : [headers[k], v];
    } else {
      headers[k] = v;
    }
  }
  return { statusCode, statusMessage, headers, body };
}

class OffshoreConnection extends EventEmitter {
  constructor(host, port) {
    super();
    this.host = host;
    this.port = port;
    this.socket = null;
    this.decoder = new FrameDecoder();
    this.queue = null; 
    this.inTunnel = false;
    this._connect();
  }

  _connect() {
    const sock = net.createConnection({ host: this.host, port: this.port });
    this.socket = sock;
    this.queue = new MessageSendQueue(sock);
    sock.on("connect", () => this.emit("connect"));
    sock.on("data", (chunk) => this.decoder.push(chunk));
    sock.on("error", (e) => this.emit("error", e));
    sock.on("close", () => {
      this.emit("close");
      setTimeout(() => this._connect(), 1000);
    });
  }

  async sendRequest(payload) {
    await this.queue.enqueue(MessageType.REQUEST, payload);
  }
}

const offshore = new OffshoreConnection(OFFSHORE_HOST, OFFSHORE_PORT);
class RequestQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
  }

  async enqueue(requestItem) {
    return new Promise((resolve, reject) => {
      this.queue.push({ ...requestItem, resolve, reject });
      this.processNext();
    });
  }

  async processNext() {
    if (this.processing || this.queue.length === 0 || offshore.inTunnel) {
      return;
    }
    
    this.processing = true;
    const item = this.queue.shift();
    
    try {
      const { req, res, rawRequest } = item;
      await offshore.sendRequest(rawRequest);
      const responseBuf = await waitForSingleResponse();
      const parsed = parseRawHttpResponse(responseBuf);
      const headers = {};
      for (const [k, v] of Object.entries(parsed.headers)) {
        headers[k] = v;
      }
      
      if (!res.headersSent) {
        res.writeHead(parsed.statusCode, headers);
        if (parsed.body && parsed.body.length) {
          res.write(parsed.body);
        }
        res.end();
      }
      
      item.resolve();
    } catch (e) {
      if (!item.res.headersSent) {
        item.res.writeHead(502, { "Content-Type": "text/plain" });
        item.res.end("Bad Gateway: " + e.message);
      }
      item.reject(e);
    } finally {
      this.processing = false;
      setImmediate(() => this.processNext());
    }
  }
}

const requestQueue = new RequestQueue();

function waitForSingleResponse() {
  return new Promise((resolve, reject) => {
    const onMessage = ({ type, payload }) => {
      if (type !== MessageType.RESPONSE) return;
      cleanup();
      resolve(Buffer.from(payload));
    };
    const onError = (e) => {
      cleanup();
      reject(e);
    };
    const cleanup = () => {
      offshore.decoder.removeListener("message", onMessage);
      offshore.removeListener("error", onError);
    };
    offshore.decoder.on("message", onMessage);
    offshore.once("error", onError);
  });
}
const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const rawRequest = serializeHttpRequest(req, body);
      await requestQueue.enqueue({ req, res, rawRequest });
    });
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Proxy error: " + e.message);
  }
});
server.on("connect", (req, clientSocket, head) => {
  (async () => {
    try {
      offshore.inTunnel = true;
      const connectLine = `${req.method} ${req.url} HTTP/${req.httpVersion}`;
      const headers = [];
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) v.forEach((vv) => headers.push(`${k}: ${vv}`));
        else headers.push(`${k}: ${v}`);
      }
      const raw = Buffer.from(connectLine + "\r\n" + headers.join("\r\n") + "\r\n\r\n", "utf8");
      await offshore.sendRequest(raw);
      const resp = await waitForSingleResponse();
      const text = resp.toString("utf8");
      if (!/^HTTP\/\d\.\d\s+200/i.test(text)) {
        clientSocket.write(resp);
        clientSocket.end();
        offshore.inTunnel = false;
        return;
      }
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) await offshore.queue.enqueue(MessageType.REQUEST, Buffer.from(head));
      const onClientData = async (data) => {
        try {
          await offshore.queue.enqueue(MessageType.REQUEST, Buffer.from(data));
        } catch {}
      };
      const onClientClose = () => {
        cleanup();
        offshore.inTunnel = false;
      };
      const onClientError = () => {
        cleanup();
        offshore.inTunnel = false;
      };

      clientSocket.on("data", onClientData);
      clientSocket.once("close", onClientClose);
      clientSocket.once("error", onClientError);
      const onMessage = async ({ type, payload }) => {
        if (!offshore.inTunnel) return;
        if (type !== MessageType.RESPONSE) return;
        if (payload && payload.length) clientSocket.write(payload);
      };
      const onOffshoreClose = () => {
        cleanup();
        offshore.inTunnel = false;
        try { clientSocket.end(); } catch {}
      };
      const cleanup = () => {
        offshore.decoder.removeListener("message", onMessage);
        offshore.removeListener("close", onOffshoreClose);
        clientSocket.removeListener("data", onClientData);
      };

      offshore.decoder.on("message", onMessage);
      offshore.once("close", onOffshoreClose);
    } catch (e) {
      try { clientSocket.end(); } catch {}
      offshore.inTunnel = false;
    }
  })();
});

server.on("clientError", (err, socket) => {
  try {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } catch {}
});

server.listen(PROXY_PORT, () => {
  console.log(`ship proxy listening on ${PROXY_PORT}, offshore ${OFFSHORE_HOST}:${OFFSHORE_PORT}`);
});


