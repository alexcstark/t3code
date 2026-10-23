// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Schema from "effect/Schema";

import { buildRemoteLaunchScript, buildRemoteStopScript } from "./tunnel.ts";

// The external CLI implements only upstream's SSH commands. Real processes,
// files, and HTTP listeners exercise the generated launch and stop scripts.
const cliSource = String.raw`
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import path from "node:path";
const args = process.argv.slice(2);
const home = path.join(process.env.HOME, ".t3");
const runtimeFile = path.join(home, "userdata/server-runtime.json");
fs.appendFileSync(path.join(home, "calls"), JSON.stringify(args) + "\n");
const notify = async (event) => {
  if (!process.env.T3_TEST_CONTROL_PORT) return;
  await new Promise((resolve, reject) => {
    const socket = net.connect(Number(process.env.T3_TEST_CONTROL_PORT), "127.0.0.1");
    socket.once("error", reject);
    socket.once("connect", () => socket.end(event + "\n"));
    socket.once("close", resolve);
  });
};
if (args[0] === "--version") {
  process.stdout.write("t3 v0.1.0\n");
} else if (args[0] === "__ssh-helper" && args[1] === "pick-port") {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(() => process.stdout.write(String(port)));
  });
} else if (args[0] === "__ssh-helper" && args[1] === "runtime-port") {
  await notify("runtime-probe");
  try {
    const runtime = JSON.parse(fs.readFileSync(args[2], "utf8"));
    process.kill(runtime.pid, 0);
    process.stdout.write(runtime.pid + " " + runtime.port);
  } catch { process.exitCode = 1; }
} else if (args[0] === "__ssh-helper" && args[1] === "wait-ready") {
  if (process.env.T3_TEST_NOT_READY === "1") process.exit(1);
  const deadline = Date.now() + Number(args[3]);
  const probe = () => new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port: Number(args[2]), timeout: 500 }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode === 200));
    });
    request.once("error", () => resolve(false));
    request.once("timeout", () => { request.destroy(); resolve(false); });
  });
  while (!(await probe())) {
    if (Date.now() >= deadline) { process.exitCode = 1; break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
} else if (args[0] === "serve") {
  fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
  fs.appendFileSync(path.join(home, "starts"), process.pid + "\n");
  const server = http.createServer((request, response) => {
    response.end("ok");
    if (request.url === "/shutdown") server.close();
  });
  server.listen(Number(args[args.indexOf("--port") + 1]), "127.0.0.1", () => {
    const runtime = {
      version: 1, pid: process.pid, port: server.address().port,
      origin: "http://127.0.0.1:" + server.address().port,
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(runtimeFile, JSON.stringify(runtime));
    process.send?.(runtime);
  });
  process.once("SIGTERM", () => server.close());
} else {
  process.stderr.write("Unsupported upstream CLI command: " + args.join(" ") + "\n");
  process.exitCode = 1;
}
`;

const firstKey = "0123456789abcdef";
const secondKey = "fedcba9876543210";
const archiveVersion = "0.1.0";
const decodeLaunch = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      remotePort: Schema.Number,
      serverKind: Schema.String,
    }),
  ),
);
const decodeRuntime = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      pid: Schema.Number,
      origin: Schema.String,
    }),
  ),
);

async function withHome(run: (home: string, cli: string) => Promise<void>) {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-upstream-ssh-"));
  const runtime = NodePath.join(home, ".t3/runtime/versions", archiveVersion);
  NodeFS.mkdirSync(runtime, { recursive: true });
  const cli = NodePath.join(runtime, "t3");
  NodeFS.writeFileSync(cli, "#!" + process.execPath + "\n" + cliSource, { mode: 0o700 });
  NodeFS.writeFileSync(NodePath.join(runtime, ".install-complete"), archiveVersion);
  try {
    await run(home, cli);
  } finally {
    const runtimeFile = NodePath.join(home, ".t3/userdata/server-runtime.json");
    if (NodeFS.existsSync(runtimeFile)) {
      const runtime = decodeRuntime(NodeFS.readFileSync(runtimeFile, "utf8"));
      await new Promise<void>((resolve) => {
        const request = NodeHttp.get(runtime.origin + "/shutdown", (response) => {
          response.resume();
          response.once("end", resolve);
        });
        request.once("error", () => resolve());
      });
    }
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
}

function runScript(home: string, script: string, key = firstKey, extraEnv = {}) {
  const child = NodeChildProcess.spawn("/bin/sh", ["-s", "--", key], {
    env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(script);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function launch(home: string, key = firstKey, extraEnv = {}) {
  const result = await runScript(home, buildRemoteLaunchScript({ archiveVersion }), key, extraEnv);
  assert.equal(result.code, 0, result.stderr);
  return decodeLaunch(result.stdout);
}

function readPid(home: string) {
  return decodeRuntime(
    NodeFS.readFileSync(NodePath.join(home, ".t3/userdata/server-runtime.json"), "utf8"),
  ).pid;
}

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("upstream SSH lifecycle", () => {
  it("starts and reconnects with only upstream helpers, preserving the running server across desktop updates", () =>
    withHome(async (home) => {
      const first = await launch(home);
      const pid = readPid(home);
      assert.equal(first.serverKind, "managed");

      // A different desktop runner must not replace or downgrade a healthy server.
      const newer = NodePath.join(home, ".t3/runtime/versions/0.2.0");
      NodeFS.cpSync(NodePath.join(home, ".t3/runtime/versions/0.1.0"), newer, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(newer, ".install-complete"), "0.2.0");
      const reconnect = await runScript(home, buildRemoteLaunchScript({ archiveVersion: "0.2.0" }));
      assert.equal(reconnect.code, 0, reconnect.stderr);
      assert.deepEqual(decodeLaunch(reconnect.stdout), first);
      assert.equal(readPid(home), pid);
      assert.equal(NodeFS.readFileSync(NodePath.join(home, ".t3/starts"), "utf8"), pid + "\n");

      const stop = await runScript(home, buildRemoteStopScript(firstKey));
      assert.equal(stop.code, 0, stop.stderr);
      assert.equal(stop.stdout, '{"stopped":true}\n');
    }));

  it.each(["fresh", "stale"] as const)(
    "serializes cold starts with a %s lock and leaves the owner's server running on an external disconnect",
    (lock) =>
      withHome(async (home) => {
        if (lock === "stale") {
          const lockDir = NodePath.join(home, ".t3/ssh-launch/connection.lock");
          NodeFS.mkdirSync(lockDir, { recursive: true });
          NodeFS.writeFileSync(NodePath.join(lockDir, "pid"), "999999999\n");
          // A previous reclaimer can itself die after publishing its PID.
          NodeFS.mkdirSync(NodePath.join(lockDir, "reclaim.999999998"));
        }
        const keys = [firstKey, secondKey];
        const results = await Promise.all(keys.map((key) => launch(home, key)));
        assert.equal(results[0]?.remotePort, results[1]?.remotePort);
        assert.deepEqual(results.map((result) => result.serverKind).sort(), [
          "external",
          "managed",
        ]);
        const externalKey = keys[results.findIndex((result) => result.serverKind === "external")];
        if (externalKey === undefined) throw new Error("No external connection was recorded.");
        const stop = await runScript(home, buildRemoteStopScript(externalKey));
        assert.equal(stop.code, 0, stop.stderr);
        const result = await launch(home, externalKey);
        assert.equal(result.serverKind, "external");
        assert.equal(
          NodeFS.readFileSync(NodePath.join(home, ".t3/starts"), "utf8").trim().split("\n").length,
          1,
        );
      }),
  );

  it.each([firstKey, secondKey])(
    "leaves an unresponsive existing server running for connection %s",
    (key) =>
      withHome(async (home) => {
        await launch(home);
        const pid = readPid(home);
        const result = await runScript(home, buildRemoteLaunchScript({ archiveVersion }), key, {
          T3_TEST_NOT_READY: "1",
        });
        assert.equal(result.code, 1);
        assert.include(result.stderr, "the server was left running");
        assert.equal(readPid(home), pid);
        assert.equal(NodeFS.readFileSync(NodePath.join(home, ".t3/starts"), "utf8"), pid + "\n");
      }),
  );

  it("adopts an existing T4 server without requiring its lifecycle controller or trusting legacy PID files", () =>
    withHome(async (home) => {
      await launch(home);
      const pid = readPid(home);
      const stateRoot = NodePath.join(home, ".t3/ssh-launch");
      NodeFS.unlinkSync(NodePath.join(stateRoot, firstKey, "start-token"));
      NodeFS.writeFileSync(
        NodePath.join(stateRoot, "server-state.json"),
        JSON.stringify({ kind: "managed", ownerKey: firstKey, pid }),
      );
      const result = await launch(home);
      assert.equal(result.serverKind, "external");
      const stop = await runScript(home, buildRemoteStopScript(firstKey));
      assert.equal(stop.code, 0, stop.stderr);
      const reconnect = await launch(home);
      assert.equal(reconnect.remotePort, result.remotePort);
      assert.equal(readPid(home), pid);
    }));

  it.each(["pending", "committed"] as const)(
    "waits for a %s service update to publish its replacement",
    (status) =>
      withHome(async (home, cli) => {
        const server = NodeChildProcess.fork(cli, ["serve", "--port", "0"], {
          env: { ...process.env, HOME: home },
          silent: true,
        });
        try {
          await new Promise<void>((resolve, reject) => {
            server.once("message", () => resolve());
            server.once("error", reject);
            server.once("exit", (code) =>
              reject(new Error(`Fixture exited before readiness: ${code}`)),
            );
          });
          const pid = readPid(home);
          const runtimeFile = NodePath.join(home, ".t3/userdata/server-runtime.json");
          const runtime = NodeFS.readFileSync(runtimeFile, "utf8");
          NodeFS.unlinkSync(runtimeFile);
          NodeFS.writeFileSync(
            NodePath.join(home, ".t3/userdata/server.lock"),
            JSON.stringify({ version: 1, pid, startedAt: "2026-10-23T00:00:00.000Z" }),
          );
          const stateFile = NodePath.join(home, ".t3/runtime/service-state.json");
          NodeFS.writeFileSync(
            stateFile,
            JSON.stringify({ activeVersion: "0.1.0", update: { status } }),
          );
          let probes = 0;
          const control = NodeNet.createServer((socket) => {
            socket.resume();
            socket.once("end", () => {
              if (++probes === 2) {
                NodeFS.writeFileSync(
                  stateFile,
                  JSON.stringify({ activeVersion: "0.1.0", update: { status: "committed" } }),
                );
                NodeFS.writeFileSync(runtimeFile, runtime);
              }
            });
          });
          await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
          const address = control.address();
          if (address === null || typeof address === "string")
            throw new Error("Control server has no TCP port.");
          try {
            const result = await launch(home, firstKey, {
              T3_TEST_CONTROL_PORT: String(address.port),
            });
            assert.equal(result.serverKind, "external");
            assert.equal(readPid(home), pid);
            assert.isAtLeast(probes, 2);
            assert.equal(
              NodeFS.readFileSync(NodePath.join(home, ".t3/starts"), "utf8"),
              pid + "\n",
            );
          } finally {
            control.close();
          }
        } finally {
          const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
          server.kill();
          await exited;
        }
      }),
  );

  it("starts a server when a stopped service left its state behind", () =>
    withHome(async (home) => {
      NodeFS.writeFileSync(
        NodePath.join(home, ".t3/runtime/service-state.json"),
        JSON.stringify({ activeVersion: "0.1.0", update: { status: "committed" } }),
      );
      const result = await launch(home);
      assert.equal(result.serverKind, "managed");
    }));
});
