// @effect-diagnostics globalDate:off globalTimers:off nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeEvents from "node:events";

import { assert, it } from "@effect/vitest";

import { ensureSshServer, probeSshServer, stopSshServer } from "./sshLifecycle.ts";

const OWNER_KEY = "0123456789abcdef";

const fakeServerSource = `
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

const version = process.env.FAKE_T3_VERSION ?? "0.0.0";
if (process.argv.includes("--version")) {
  process.stdout.write("t3 v" + version + "\\n");
  process.exit(0);
}
const valueAfter = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const port = Number(valueAfter("--port"));
const baseDir = valueAfter("--base-dir");
if (!Number.isInteger(port) || !baseDir) process.exit(2);
const runtimePath = path.join(baseDir, "userdata", "server-runtime.json");
const providerPath = path.join(baseDir, "provider.pid");
fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
const provider = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: "ignore",
});
fs.writeFileSync(providerPath, String(provider.pid));
const startedAt = new Date().toISOString();
const server = http.createServer((request, response) => {
  if (request.url !== "/.well-known/t3/environment") {
    response.writeHead(404).end();
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({
    environmentId: "00000000-0000-4000-8000-000000000001",
    label: "SSH lifecycle test",
    platform: { os: process.platform === "darwin" ? "darwin" : "linux", arch: "x64" },
    serverVersion: version,
    capabilities: { repositoryIdentity: false }
  }));
});
server.listen(port, "127.0.0.1", () => {
  fs.writeFileSync(runtimePath, JSON.stringify({
    version: 1,
    pid: process.pid,
    port,
    origin: "http://127.0.0.1:" + String(port),
    startedAt,
    ...(process.env.FAKE_SERVICE_MANAGED === "1" ? { serviceManaged: true } : {})
  }) + "\\n");
});
const shutdown = () => server.close(() => {
  try {
    const state = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
    if (state.pid === process.pid) fs.rmSync(runtimePath, { force: true });
  } catch {}
  process.exit(0);
});
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
`;

interface Harness {
  readonly root: string;
  readonly stateRoot: string;
  readonly baseDir: string;
  readonly stableRunnerPath: string;
  readonly serverPath: string;
}

function makeHarness(): Harness {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-lifecycle-"));
  const stateRoot = NodePath.join(root, "home", ".t3", "ssh-launch");
  const baseDir = NodePath.join(root, "home", ".t3");
  const stableRunnerPath = NodePath.join(stateRoot, "run-t3.sh");
  const serverPath = NodePath.join(root, "fake-server.mjs");
  NodeFS.mkdirSync(stateRoot, { recursive: true });
  NodeFS.writeFileSync(serverPath, fakeServerSource);
  return { root, stateRoot, baseDir, stableRunnerPath, serverPath };
}

function writeRunner(harness: Harness, name: string, version: string): string {
  const runnerPath = NodePath.join(harness.stateRoot, name);
  const source = [
    "#!/bin/sh",
    `FAKE_T3_VERSION='${version}' exec '${process.execPath}' '${harness.serverPath}' "$@"`,
    "",
  ].join("\n");
  NodeFS.writeFileSync(runnerPath, source, { mode: 0o700 });
  return runnerPath;
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) {
        reject(new Error("Test server did not reserve a TCP port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!NodeFS.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (processExists(pid)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for PID ${String(pid)}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function spawnFakeServer(
  harness: Harness,
  runnerPath: string,
  port: number,
  serviceManaged = false,
): NodeChildProcess.ChildProcess {
  return NodeChildProcess.spawn(
    runnerPath,
    ["serve", "--host", "127.0.0.1", "--port", String(port), "--base-dir", harness.baseDir],
    {
      detached: true,
      env: { ...process.env, ...(serviceManaged ? { FAKE_SERVICE_MANAGED: "1" } : {}) },
      stdio: "ignore",
    },
  );
}

async function stopTestProcess(child: NodeChildProcess.ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  await NodeEvents.EventEmitter.once(child, "exit").catch(() => undefined);
}

it("reuses the same legacy-managed server without signaling it", async () => {
  const harness = makeHarness();
  const runner = writeRunner(harness, "candidate.sh", "1.2.3");
  const port = await reservePort();
  const child = spawnFakeServer(harness, runner, port);
  try {
    await waitForFile(NodePath.join(harness.baseDir, "userdata", "server-runtime.json"));
    const pid = child.pid;
    assert.isDefined(pid);
    const legacy = NodePath.join(harness.stateRoot, OWNER_KEY);
    NodeFS.mkdirSync(legacy, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(legacy, "pid"), `${String(pid)}\n`);
    NodeFS.writeFileSync(NodePath.join(legacy, "port"), `${String(port)}\n`);
    NodeFS.writeFileSync(NodePath.join(legacy, "managed"), "managed\n");

    const ensured = await ensureSshServer({
      stateRoot: harness.stateRoot,
      ownerKey: OWNER_KEY,
      expectedVersion: "1.2.3",
      runnerId: "runner-one",
      candidateRunnerPath: runner,
      stableRunnerPath: harness.stableRunnerPath,
      baseDir: harness.baseDir,
    });
    assert.equal(ensured.decision, "reuse-managed");
    assert.equal(ensured.remotePid, pid);
    assert.isTrue(processExists(pid));

    const probed = await probeSshServer({
      stateRoot: harness.stateRoot,
      ownerKey: OWNER_KEY,
      expectedVersion: "1.2.3",
      runnerId: "runner-one",
      baseDir: harness.baseDir,
    });
    assert.deepInclude(probed, { status: "ready", decision: "reuse-managed", remotePid: pid });

    const exited = NodeEvents.EventEmitter.once(child, "exit");
    assert.deepEqual(
      await stopSshServer({
        stateRoot: harness.stateRoot,
        ownerKey: OWNER_KEY,
        baseDir: harness.baseDir,
      }),
      { stopped: true },
    );
    await exited;
    assert.isFalse(processExists(pid));
    const providerPid = Number(NodeFS.readFileSync(NodePath.join(harness.baseDir, "provider.pid")));
    assert.isFalse(processExists(providerPid));
  } finally {
    await stopTestProcess(child);
    NodeFS.rmSync(harness.root, { recursive: true, force: true });
  }
}, 20_000);

it("adopts a service-managed server and never stops it", async () => {
  const harness = makeHarness();
  const runner = writeRunner(harness, "candidate.sh", "1.2.3");
  const port = await reservePort();
  const child = spawnFakeServer(harness, runner, port, true);
  try {
    await waitForFile(NodePath.join(harness.baseDir, "userdata", "server-runtime.json"));
    const pid = child.pid;
    assert.isDefined(pid);
    const ensured = await ensureSshServer({
      stateRoot: harness.stateRoot,
      ownerKey: OWNER_KEY,
      expectedVersion: "9.9.9",
      runnerId: "different-runner",
      candidateRunnerPath: runner,
      stableRunnerPath: harness.stableRunnerPath,
      baseDir: harness.baseDir,
    });
    assert.deepInclude(ensured, {
      decision: "reuse-external",
      serverKind: "external",
      remotePid: pid,
    });
    assert.deepEqual(
      await stopSshServer({
        stateRoot: harness.stateRoot,
        ownerKey: OWNER_KEY,
        baseDir: harness.baseDir,
      }),
      { stopped: false },
    );
    assert.isTrue(processExists(pid));
  } finally {
    await stopTestProcess(child);
    NodeFS.rmSync(harness.root, { recursive: true, force: true });
  }
}, 20_000);

it("serializes concurrent cold starts and performs one controlled upgrade", async () => {
  const harness = makeHarness();
  const port = await reservePort();
  try {
    const staleLock = NodePath.join(harness.stateRoot, "server-state.lock");
    NodeFS.mkdirSync(staleLock);
    NodeFS.writeFileSync(
      NodePath.join(staleLock, "owner.json"),
      '{"version":1,"token":"stale","pid":2147483647,"processStartToken":"gone"}\n',
    );
    const first = ensureSshServer({
      stateRoot: harness.stateRoot,
      ownerKey: OWNER_KEY,
      expectedVersion: "1.2.3",
      runnerId: "runner-one",
      candidateRunnerPath: writeRunner(harness, "candidate-one.sh", "1.2.3"),
      stableRunnerPath: harness.stableRunnerPath,
      baseDir: harness.baseDir,
      defaultPort: port,
    });
    const second = ensureSshServer({
      stateRoot: harness.stateRoot,
      ownerKey: OWNER_KEY,
      expectedVersion: "1.2.3",
      runnerId: "runner-one",
      candidateRunnerPath: writeRunner(harness, "candidate-two.sh", "1.2.3"),
      stableRunnerPath: harness.stableRunnerPath,
      baseDir: harness.baseDir,
      defaultPort: port,
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.remotePid, secondResult.remotePid);
    assert.deepEqual(
      new Set([firstResult.decision, secondResult.decision]),
      new Set(["cold-start", "reuse-managed"]),
    );

    const upgraded = await ensureSshServer({
      stateRoot: harness.stateRoot,
      ownerKey: OWNER_KEY,
      expectedVersion: "2.0.0",
      runnerId: "runner-two",
      candidateRunnerPath: writeRunner(harness, "candidate-upgrade.sh", "2.0.0"),
      stableRunnerPath: harness.stableRunnerPath,
      baseDir: harness.baseDir,
      defaultPort: port,
    });
    assert.equal(upgraded.decision, "upgrade-managed");
    assert.notEqual(upgraded.remotePid, firstResult.remotePid);
    assert.equal(upgraded.serverVersion, "2.0.0");
    assert.isFalse(processExists(firstResult.remotePid));

    const olderClient = await ensureSshServer({
      stateRoot: harness.stateRoot,
      ownerKey: OWNER_KEY,
      expectedVersion: "1.5.0",
      runnerId: "older-runner",
      candidateRunnerPath: writeRunner(harness, "candidate-older.sh", "1.5.0"),
      stableRunnerPath: harness.stableRunnerPath,
      baseDir: harness.baseDir,
      defaultPort: port,
    });
    assert.equal(olderClient.decision, "reuse-managed");
    assert.equal(olderClient.remotePid, upgraded.remotePid);
    assert.equal(olderClient.serverVersion, "2.0.0");
    assert.include(
      NodeFS.readFileSync(harness.stableRunnerPath, "utf8"),
      "FAKE_T3_VERSION='2.0.0'",
    );

    process.kill(-upgraded.remotePid, "SIGKILL");
    await waitForProcessExit(upgraded.remotePid);
    const recoveredForOlderClient = await ensureSshServer({
      stateRoot: harness.stateRoot,
      ownerKey: OWNER_KEY,
      expectedVersion: "1.5.0",
      runnerId: "another-older-runner",
      candidateRunnerPath: writeRunner(harness, "candidate-older-recovery.sh", "1.5.0"),
      stableRunnerPath: harness.stableRunnerPath,
      baseDir: harness.baseDir,
      defaultPort: port,
    });
    assert.equal(recoveredForOlderClient.decision, "restart-unhealthy");
    assert.equal(recoveredForOlderClient.serverVersion, "2.0.0");
    assert.notEqual(recoveredForOlderClient.remotePid, upgraded.remotePid);

    assert.deepEqual(
      await stopSshServer({
        stateRoot: harness.stateRoot,
        ownerKey: OWNER_KEY,
        baseDir: harness.baseDir,
      }),
      { stopped: true },
    );
  } finally {
    const statePath = NodePath.join(harness.stateRoot, "server-state.json");
    if (NodeFS.existsSync(statePath)) {
      const state = JSON.parse(NodeFS.readFileSync(statePath, "utf8")) as { pid?: number };
      if (state.pid !== undefined) {
        try {
          process.kill(-state.pid, "SIGKILL");
        } catch {}
      }
    }
    NodeFS.rmSync(harness.root, { recursive: true, force: true });
  }
}, 30_000);
