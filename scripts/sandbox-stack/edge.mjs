// Local harness: (1) Kong-like gateway on :54321 routing /auth/v1 -> GoTrue, /rest/v1 -> PostgREST
//                (2) SMTP sink on :54325 + Mailpit-style HTTP API on :54324
// Not part of the repo; test-only emulation of the Supabase local stack.
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";

const GOTRUE = { host: "127.0.0.1", port: 9999 };
const POSTGREST = { host: "127.0.0.1", port: 3001 };

function route(req, res) {
  if (req.url.startsWith("/templates/")) {
    try {
      const body = fs.readFileSync((process.env.REPO ?? process.cwd()) + "/supabase" + req.url.split("?")[0]);
      res.writeHead(200, { "content-type": "text/html" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
    return;
  }
  let target;
  let path = req.url;
  if (path.startsWith("/auth/v1/")) {
    target = GOTRUE;
    path = path.slice("/auth/v1".length);
  } else if (path.startsWith("/rest/v1/")) {
    target = POSTGREST;
    path = path.slice("/rest/v1".length);
  } else {
    res.writeHead(404).end("not found");
    return;
  }
  const headers = { ...req.headers, host: `${target.host}:${target.port}` };
  const upstream = http.request({ ...target, path, method: req.method, headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on("error", (e) => res.writeHead(502).end(String(e)));
  req.pipe(upstream);
}
http.createServer(route).listen(54321, "127.0.0.1", () => console.log("gateway :54321"));

// ---- SMTP sink ----
const messages = [];
function parseMessage(raw) {
  const [head, ...rest] = raw.split(/\r?\n\r?\n/);
  const body = rest.join("\n\n");
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  const decode = (s) =>
    s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return { headers, text: decode(body) };
}
net
  .createServer((sock) => {
    let buf = "";
    let data = false;
    let rcpt = [];
    sock.write("220 sink ESMTP\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (data) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          const raw = buf.slice(0, end);
          buf = buf.slice(end + 5);
          data = false;
          const m = parseMessage(raw);
          messages.push({
            ID: crypto.randomUUID(),
            Created: new Date().toISOString(),
            To: rcpt.map((a) => ({ Address: a })),
            Subject: m.headers["subject"] ?? "",
            Text: m.text,
            HTML: m.text,
          });
          rcpt = [];
          sock.write("250 OK\r\n");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") sock.write("250-sink\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (cmd === "AUTH") sock.write("235 ok\r\n");
        else if (cmd === "MAIL") sock.write("250 OK\r\n");
        else if (cmd === "RCPT") {
          const m = /<([^>]+)>/.exec(line);
          if (m) rcpt.push(m[1]);
          sock.write("250 OK\r\n");
        } else if (cmd === "DATA") {
          data = true;
          sock.write("354 go\r\n");
        } else if (cmd === "QUIT") {
          sock.write("221 bye\r\n");
          sock.end();
        } else if (cmd === "RSET" || cmd === "NOOP") sock.write("250 OK\r\n");
        else sock.write("250 OK\r\n");
      }
    });
    sock.on("error", () => undefined);
  })
  .listen(54325, "127.0.0.1", () => console.log("smtp :54325"));

http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    res.setHeader("content-type", "application/json");
    if (u.pathname === "/api/v1/messages" && req.method === "GET") {
      res.end(
        JSON.stringify({
          total: messages.length,
          messages: [...messages].reverse().map(({ ID, To, Subject, Created }) => ({
            ID,
            To,
            Subject,
            Created,
          })),
        }),
      );
    } else if (u.pathname.startsWith("/api/v1/message/") && req.method === "GET") {
      const m = messages.find((x) => x.ID === u.pathname.split("/").pop());
      if (!m) return res.writeHead(404).end("{}");
      res.end(JSON.stringify(m));
    } else if (u.pathname === "/api/v1/messages" && req.method === "DELETE") {
      messages.length = 0;
      res.end("{}");
    } else res.writeHead(404).end("{}");
  })
  .listen(54324, "127.0.0.1", () => console.log("mail api :54324"));
