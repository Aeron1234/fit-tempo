import { app, config } from "./app.js";

const server = app.listen(config.PORT, () => {
  console.info(`Fit Tempo API listening on http://localhost:${config.PORT}`);
});

server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(`Fit Tempo API failed to listen (${error.code ?? "UNKNOWN"}).`);
  process.exitCode = 1;
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
