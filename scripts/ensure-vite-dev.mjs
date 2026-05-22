import { spawn } from "node:child_process";
import net from "node:net";

const host = "127.0.0.1";
const port = 1420;

if (await isDevServerRunning(host, port)) {
  process.exit(0);
}

const npmExecPath = process.env.npm_execpath;
const command = npmExecPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const args = npmExecPath ? [npmExecPath, "run", "dev"] : ["run", "dev"];
const child = spawn(command, args, {
  stdio: "inherit",
  shell: !npmExecPath && process.platform === "win32",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("exit", (code) => {
  process.exit(code ?? 1);
});

async function isDevServerRunning(targetHost, targetPort) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);
  try {
    await fetch(`http://${targetHost}:${targetPort}/`, {
      signal: controller.signal,
    });
    return true;
  } catch {
    return isPortOpen(targetHost, targetPort);
  } finally {
    clearTimeout(timeout);
  }
}

function isPortOpen(targetHost, targetPort) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: targetHost, port: targetPort });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}
