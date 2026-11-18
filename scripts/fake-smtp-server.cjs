/*
 * Minimal fake SMTP server for isolated end-to-end tests.
 * Never used by the application itself.
 *
 * Behaviour is selected per connection from a mode file so a single running
 * server can simulate the different failure classes:
 *   accept            - message accepted (250)
 *   reject-recipient  - RCPT TO rejected (550)
 *   auth-fail         - AUTH rejected (535)
 *   drop-on-data      - connection dropped mid-DATA
 *
 * Accepted messages are written to the outbox directory.
 */
const net = require("net");
const fs = require("fs");
const path = require("path");

const readMode = (modeFile) => {
  try {
    return fs.readFileSync(modeFile, "utf8").trim() || "accept";
  } catch {
    return "accept";
  }
};

const startFakeSmtp = ({ port, modeFile, outboxDir }) => {
  fs.mkdirSync(outboxDir, { recursive: true });
  const sockets = new Set();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});

    const mode = readMode(modeFile);
    let buffer = "";
    let inData = false;
    let dataParts = [];
    let mailFrom = "";
    let recipients = [];
    let authStep = 0;

    const send = (line) => {
      if (!socket.destroyed) socket.write(`${line}\r\n`);
    };

    send("220 fake-smtp ready");

    const finishMessage = (body) => {
      const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      fs.writeFileSync(path.join(outboxDir, `${id}.eml`), body, "utf8");
      fs.appendFileSync(
        path.join(outboxDir, "messages.jsonl"),
        `${JSON.stringify({ id, mailFrom, recipients, bytes: body.length, at: new Date().toISOString() })}\n`,
        "utf8",
      );
      return id;
    };

    const handleLine = (line) => {
      const upper = line.toUpperCase();

      if (authStep === 1) {
        authStep = 2;
        send("334 UGFzc3dvcmQ6");
        return;
      }
      if (authStep === 2) {
        authStep = 0;
        send("235 2.7.0 Authentication successful");
        return;
      }
      if (authStep === 3) {
        authStep = 0;
        if (mode === "auth-fail") send("535 5.7.8 Authentication failed");
        else send("235 2.7.0 Authentication successful");
        return;
      }

      if (upper.startsWith("EHLO")) {
        send("250-fake-smtp");
        send("250-AUTH LOGIN PLAIN");
        send("250-8BITMIME");
        send("250 SIZE 52428800");
        return;
      }
      if (upper.startsWith("HELO")) {
        send("250 fake-smtp");
        return;
      }
      if (upper.startsWith("AUTH LOGIN")) {
        if (mode === "auth-fail") {
          send("535 5.7.8 Authentication failed");
          return;
        }
        authStep = 1;
        send("334 VXNlcm5hbWU6");
        return;
      }
      if (upper.startsWith("AUTH PLAIN")) {
        if (line.trim().split(/\s+/).length > 2) {
          if (mode === "auth-fail") send("535 5.7.8 Authentication failed");
          else send("235 2.7.0 Authentication successful");
          return;
        }
        authStep = 3;
        send("334 ");
        return;
      }
      if (upper.startsWith("MAIL FROM")) {
        mailFrom = line;
        send("250 2.1.0 OK");
        return;
      }
      if (upper.startsWith("RCPT TO")) {
        if (mode === "reject-recipient") {
          send("550 5.1.1 Recipient address rejected");
          return;
        }
        recipients.push(line);
        send("250 2.1.5 OK");
        return;
      }
      if (upper === "DATA") {
        inData = true;
        dataParts = [];
        send("354 End data with <CR><LF>.<CR><LF>");
        return;
      }
      if (upper === "QUIT") {
        send("221 Bye");
        socket.end();
        return;
      }
      if (upper === "RSET") {
        mailFrom = "";
        recipients = [];
        send("250 OK");
        return;
      }
      if (upper === "NOOP") {
        send("250 OK");
        return;
      }
      send("250 OK");
    };

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      if (inData) {
        const terminator = buffer.indexOf("\r\n.\r\n");
        if (terminator === -1) {
          if (buffer.length > 65536) {
            dataParts.push(buffer);
            buffer = "";
          }
          return;
        }
        dataParts.push(buffer.slice(0, terminator));
        const body = dataParts.join("");
        inData = false;
        dataParts = [];
        buffer = buffer.slice(terminator + 5);

        if (mode === "drop-on-data") {
          socket.destroy();
          return;
        }
        const id = finishMessage(body);
        recipients = [];
        mailFrom = "";
        send(`250 2.0.0 queued as ${id}`);
        return;
      }

      let index;
      while ((index = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handleLine(line);
      }
    });
  });

  server.on("error", () => {});

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        server,
        port,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
};

module.exports = { startFakeSmtp };
