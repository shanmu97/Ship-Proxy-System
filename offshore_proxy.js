"use strict";

const net = require("net");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const {
  MessageType,
  FrameDecoder,
  MessageSendQueue,
  sendMessage,
} = require("./protocol");

const LISTEN_PORT = process.env.OFFSHORE_PORT ? Number(process.env.OFFSHORE_PORT) : 9999;


function parseHttpRequest(buf) {
  const text = buf.toString("utf8");
  const sep = "\r\n\r\n";
  const headerEnd = text.indexOf(sep);
  const head = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
  const body = headerEnd >= 0 ? Buffer.from(text.slice(headerEnd + sep.length), "utf8") : Buffer.alloc(0);

  const lines = head.split("\r\n");
  const [requestLine, ...headerLines] = lines;
  const [method, path, version] = requestLine.split(" ");
  const headers = {};
  for (const line of headerLines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    const key = k.toLowerCase();
    if (headers[key] !== undefined) {
      headers[key] = Array.isArray(headers[key]) ? [...headers[key], v] : [headers[key], v];
    } else {
      headers[key] = v;
    }
  }

  return { method, path, version: version || "HTTP/1.1", headers, body };
}

function buildRawHttpResponse(statusCode, statusMessage, headers, bodyBuffer) {
  const version = "HTTP/1.1";
  const statusLine = `${version} ${statusCode} ${statusMessage}`;
  const headerLines = [];
  for (const [k, v] of Object.entries(headers)) {
    if (Array.isArray(v)) {
      for (const item of v) headerLines.push(`${k}: ${item}`);
    } else {
      headerLines.push(`${k}: ${v}`);
    }
  }
  const head = statusLine + "\r\n" + headerLines.join("\r\n") + "\r\n\r\n";
  return Buffer.concat([Buffer.from(head, "utf8"), bodyBuffer || Buffer.alloc(0)]);
}

function chooseAgentAndOptions(method, path, headers) {
  let url;
  if (/^https?:\/\//i.test(path)) {
    url = new URL(path);
  } else {
    const host = headers["host"] || headers[":authority"];
    const proto = useHttps ? "https:" : "http:";
    url = new URL(`${proto}//${host}${path.startsWith("/") ? path : "/" + path}`);
  }
  const isHttps = url.protocol === "https:";
  const port = url.port ? Number(url.port) : (isHttps ? 443 : 80);
  const options = {
    protocol: url.protocol,
    hostname: url.hostname,
    port,
    method,
    path: url.pathname + (url.search || ""),
    headers: headersOriginalCase(headers),
  };
  return { isHttps, options };
}

function headersOriginalCase(lowercaseHeaders) {
  const map = {
    host: "Host",
    connection: "Connection",
    "proxy-connection": "Proxy-Connection",
    "content-length": "Content-Length",
    "content-type": "Content-Type",
    accept: "Accept",
    "accept-encoding": "Accept-Encoding",
    "user-agent": "User-Agent",
    "transfer-encoding": "Transfer-Encoding",
  };
  const out = {};
  for (const [k, v] of Object.entries(lowercaseHeaders)) {
    const name = map[k] || k;
    out[name] = v;
  }
  return out;
}

function startServer() {
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    const queue = new MessageSendQueue(socket);

    let inTunnel = false;
    let tunnelUpstream = null;

    socket.on("data", (chunk) => decoder.push(chunk));
    socket.on("error", (e) => console.error("offshore socket error:", e.message));
    socket.on("close", () => {
      if (tunnelUpstream) tunnelUpstream.destroy();
    });

    decoder.on("message", async ({ type, payload }) => {
      try {
        if (type !== MessageType.REQUEST) return;

        if (inTunnel && tunnelUpstream) {
          tunnelUpstream.write(payload);
          return;
        }
        const req = parseHttpRequest(payload);

        if (req.method === "CONNECT") {

          const [host, portStr] = req.path.split(":");
          const port = portStr ? Number(portStr) : 443;
          const upstream = net.connect({ host, port }, async () => {
            inTunnel = true;
            tunnelUpstream = upstream;
            const okPayload = Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n", "utf8");
            await queue.enqueue(MessageType.RESPONSE, okPayload);
          });
          upstream.on("data", async (data) => {
            try {
              await queue.enqueue(MessageType.RESPONSE, Buffer.from(data));
            } catch (e) {
            }
          });
          upstream.on("error", async () => {
            try {
              await queue.enqueue(MessageType.RESPONSE, Buffer.from("", "utf8"));
            } catch {}
          });
          upstream.on("close", () => {
            inTunnel = false;
            tunnelUpstream = null;
          });
          return;
        }

        const { isHttps, options } = chooseAgentAndOptions(req.method, req.path, req.headers);

        delete options.headers["Proxy-Connection"];
        delete options.headers["proxy-connection"];
        delete options.headers["Connection"];
        delete options.headers["connection"];
        delete options.headers["Transfer-Encoding"];
        delete options.headers["transfer-encoding"];

        const agent = isHttps ? https : http;

        const upstreamReq = agent.request(options, async (upRes) => {
          const chunks = [];
          upRes.on("data", (c) => chunks.push(c));
          upRes.on("end", async () => {
            const body = Buffer.concat(chunks);
            const headers = {};
            for (const [k, v] of Object.entries(upRes.headers)) {
              headers[k] = v;
            }
            
            headers["Content-Length"] = Buffer.byteLength(body);
            const statusMessage = http.STATUS_CODES[upRes.statusCode] || "";
            const raw = buildRawHttpResponse(upRes.statusCode, statusMessage, headers, body);
            await queue.enqueue(MessageType.RESPONSE, raw);
          });
        });
        upstreamReq.on("error", async (err) => {
          const body = Buffer.from(String(err.message || "Upstream request error"));
          const raw = buildRawHttpResponse(502, "Bad Gateway", {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Length": Buffer.byteLength(body),
            Connection: "close",
          }, body);
          await queue.enqueue(MessageType.RESPONSE, raw);
        });

        if (req.body && req.body.length) {
          upstreamReq.write(req.body);
        }
        upstreamReq.end();
      } catch (e) {
        try {
          const body = Buffer.from("Internal error: " + e.message);
          const raw = buildRawHttpResponse(500, "Internal Server Error", {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Length": Buffer.byteLength(body),
            Connection: "close",
          }, body);
          await sendMessage(socket, MessageType.RESPONSE, raw);
        } catch {}
      }
    });
  });

  server.on("error", (e) => {
    console.error("server error:", e.message);
  });
  server.listen(LISTEN_PORT, () => {
    console.log(`offshore proxy listening on ${LISTEN_PORT}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer };
