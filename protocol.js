"use strict";

const net = require("net");
const { EventEmitter } = require("events");

// Message types
const MessageType = Object.freeze({
  REQUEST: 0,
  RESPONSE: 1,
});

// 4 bytes length (big-endian) + 1 byte type
const HEADER_LENGTH = 5;

/**
 * Encode a framed message.
 * @param {number} messageType - 0=request, 1=response
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function encodeMessage(messageType, payload) {
  if (!Buffer.isBuffer(payload)) {
    throw new TypeError("payload must be a Buffer");
  }
  if (messageType !== MessageType.REQUEST && messageType !== MessageType.RESPONSE) {
    throw new RangeError("invalid messageType");
  }

  const header = Buffer.allocUnsafe(HEADER_LENGTH);
  header.writeUInt32BE(payload.length, 0);
  header.writeUInt8(messageType, 4);
  return Buffer.concat([header, payload]);
}

/**
 * Backpressure-aware write of a single framed message to a socket.
 * Resolves when the data is flushed if backpressure occurs.
 * @param {net.Socket} socket
 * @param {number} messageType
 * @param {Buffer} payload
 * @returns {Promise<void>}
 */
function sendMessage(socket, messageType, payload) {
  const framed = encodeMessage(messageType, payload);
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before write completed"));
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      socket.removeListener("drain", onDrain);
    };

    socket.once("error", onError);
    socket.once("close", onClose);
    const ok = socket.write(framed, (err) => {
      if (err) {
        cleanup();
        reject(err);
        return;
      }
      // If write returned false, wait for drain; otherwise resolve now
      if (ok === false) return; // drain handler will resolve
      cleanup();
      resolve();
    });
    if (ok === false) {
      socket.once("drain", onDrain);
    }
  });
}

/**
 * Streaming frame decoder for the protocol. Feed it with `socket.on('data')`.
 * Emits 'message' events: ({ type: number, payload: Buffer })
 */
class FrameDecoder extends EventEmitter {
  constructor() {
    super();
    this._buffer = Buffer.alloc(0);
    this._closed = false;
  }

  /**
   * Push incoming bytes into the decoder.
   * @param {Buffer} chunk
   */
  push(chunk) {
    if (this._closed) return;
    if (!Buffer.isBuffer(chunk)) {
      throw new TypeError("chunk must be a Buffer");
    }
    this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);
    this._parseAvailableFrames();
  }

  close() {
    this._closed = true;
    this._buffer = Buffer.alloc(0);
  }

  _parseAvailableFrames() {
    // Parse as many complete frames as are available
    while (this._buffer.length >= HEADER_LENGTH) {
      const length = this._buffer.readUInt32BE(0);
      const type = this._buffer.readUInt8(4);
      const total = HEADER_LENGTH + length;
      if (this._buffer.length < total) break; // wait for more bytes

      const payload = this._buffer.subarray(HEADER_LENGTH, total);
      // Advance buffer
      this._buffer = this._buffer.length === total ? Buffer.alloc(0) : this._buffer.subarray(total);

      this.emit("message", { type, payload });
    }
  }
}

/**
 * Simple queue to serialize message sends and handle backpressure.
 */
class MessageSendQueue {
  /**
   * @param {net.Socket} socket
   */
  constructor(socket) {
    this.socket = socket;
    this.queue = [];
    this.isSending = false;
  }

  /**
   * Enqueue a message for sending.
   * @param {number} type
   * @param {Buffer} payload
   * @returns {Promise<void>}
   */
  enqueue(type, payload) {
    return new Promise((resolve, reject) => {
      this.queue.push({ type, payload, resolve, reject });
      if (!this.isSending) this._dequeueAndSend();
    });
  }

  async _dequeueAndSend() {
    if (this.isSending) return;
    this.isSending = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        try {
          await sendMessage(this.socket, item.type, item.payload);
          item.resolve();
        } catch (err) {
          item.reject(err);
        }
      }
    } finally {
      this.isSending = false;
    }
  }
}

module.exports = {
  MessageType,
  HEADER_LENGTH,
  encodeMessage,
  sendMessage,
  FrameDecoder,
  MessageSendQueue,
};

// If executed directly, run a tiny demo server and client to verify framing
if (require.main === module) {
  const PORT = process.env.PORT ? Number(process.env.PORT) : 9090;

  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => decoder.push(chunk));
    socket.on("error", (e) => console.error("server socket error:", e.message));
    decoder.on("message", async ({ type, payload }) => {
      // Echo back with flipped type (request -> response)
      const replyType = type === MessageType.REQUEST ? MessageType.RESPONSE : type;
      try {
        await sendMessage(socket, replyType, Buffer.from(payload));
      } catch (e) {
        console.error("server send error:", e.message);
      }
    });
  });
  server.listen(PORT, () => {
    console.log(`framing demo server listening on ${PORT}`);

    // Demo client
    const client = net.createConnection({ port: PORT }, async () => {
      const decoder = new FrameDecoder();
      client.on("data", (chunk) => decoder.push(chunk));
      decoder.on("message", ({ type, payload }) => {
        console.log("client received type=", type, "bytes=", payload.length);
        client.end();
        server.close();
      });

      // Send two framed messages back-to-back to validate de-framing
      const queue = new MessageSendQueue(client);
      const payload1 = Buffer.from("GET / HTTP/1.1\r\nHost: example\r\n\r\n");
      const payload2 = Buffer.from("GET /two HTTP/1.1\r\nHost: example\r\n\r\n");
      await Promise.all([
        queue.enqueue(MessageType.REQUEST, payload1),
        queue.enqueue(MessageType.REQUEST, payload2),
      ]);
    });
    client.on("error", (e) => console.error("client error:", e.message));
  });
}


