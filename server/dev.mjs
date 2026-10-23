import http from "node:http";

import {
  createServer as createViteServer,
} from "vite";

import {
  routeRequest,
} from "./router.mjs";

const port = 5174;
let vite;

const server = http.createServer(
  async (req, res) => {
    if (!req.url.startsWith("/api/")) {
      return vite.middlewares(req, res);
    }

    try {
      const allowedHosts = [
        "127.0.0.1:5174",
        "localhost:5174",
      ];

      if (
        !allowedHosts.includes(req.headers.host)
      ) {
        res.writeHead(400).end();
        return;
      }

      const pathname = req.url.split("?")[0];

      const bodyLimit =
        pathname === "/api/sync"
          ? 256000
          : 4096;

      const chunks = [];
      let size = 0;

      for await (const chunk of req) {
        size += chunk.length;

        if (size > bodyLimit) {
          res.writeHead(413).end();
          return;
        }

        chunks.push(chunk);
      }

      const request = new Request(
        `http://${req.headers.host}${req.url}`,
        {
          method: req.method,
          headers: req.headers,

          body: ["GET", "HEAD"].includes(
            req.method,
          )
            ? undefined
            : Buffer.concat(chunks),
        },
      );

      const response = await routeRequest(
        request,
        {
          ip: req.socket.remoteAddress,
        },
      );

      res.writeHead(
        response.status,
        Object.fromEntries(response.headers),
      );

      res.end(
        Buffer.from(
          await response.arrayBuffer(),
        ),
      );
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, {
          "Content-Type": "application/json",
        });
      }

      res.end(
        JSON.stringify({
          error:
            "The local server could not complete the request.",
        }),
      );
    }
  },
);

vite = await createViteServer({
  server: {
    middlewareMode: true,

    hmr: {
      server,
    },
  },

  appType: "spa",
});

server.on("error", (error) => {
  console.error(
    error.code === "EADDRINUSE"
      ? "Port 5174 is busy. Close the other owner portal terminal."
      : "Could not start the local server.",
  );

  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  console.log(
    "Selani Owner: http://127.0.0.1:5174",
  );
});

process.on("SIGINT", async () => {
  await vite.close();
  server.close();
  process.exit(0);
});