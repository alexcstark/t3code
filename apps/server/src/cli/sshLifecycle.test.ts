// @effect-diagnostics globalDate:off globalTimers:off nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeEvents from "node:events";

import { assert, expect, it } from "@effect/vitest";

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
const delayedDescriptorPidPath = path.join(baseDir, "delayed-descriptor.pid");
const unresponsiveDescriptorPidPath = path.join(baseDir, "unresponsive-descriptor.pid");
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
  const respond = () => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      environmentId: "00000000-0000-4000-8000-000000000001",
      label: "SSH lifecycle test",
      platform: { os: process.platform === "darwin" ? "darwin" : "linux", arch: "x64" },
      serverVersion: version,
      capabilities: { repositoryIdentity: false }
    }));
  };
  let delayedPid = "";
  let unresponsivePid = "";
  try {
    delayedPid = fs.readFileSync(delayedDescriptorPidPath, "utf8").trim();
  } catch {}
  try {
    unresponsivePid = fs.readFileSync(unresponsiveDescriptorPidPath, "utf8").trim();
  } catch {}
  if (unresponsivePid === String(process.pid)) return;
  if (delayedPid === String(process.pid)) {
    setTimeout(respond, 1500);
  } else {
    respond();
  }
});
server.listen(port, "127.0.0.1", async () => {
  if (process.env.FAKE_WAIT_FOR_RUNTIME === "1") {
    const publish = new Promise((resolve) => process.once("message", resolve));
    process.send?.({ type: "runtime-pending" });
    await publish;
  }
  const serviceStatePath = path.join(baseDir, "runtime", "service-state.json");
  if (process.env.FAKE_SERVICE_MANAGED === "1" && fs.existsSync(serviceStatePath)) {
    const state = JSON.parse(fs.readFileSync(serviceStatePath, "utf8"));
    if (state.update?.status === "pending" && state.update.targetVersion === version) {
      fs.writeFileSync(serviceStatePath, JSON.stringify({
        ...state, activeVersion: version, update: { ...state.update, status: "committed" }
      }));
    }
  }
  fs.writeFileSync(runtimePath, JSON.stringify({
    version: 1,
    pid: process.pid,
    port,
    origin: "http://127.0.0.1:" + String(port),
    startedAt,
    ...(process.env.FAKE_SERVICE_MANAGED === "1" ? { serviceManaged: true } : {})
  }) + "\\n");
  process.send?.({ type: "ready" });
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
  waitForRuntime = false,
): NodeChildProcess.ChildProcess {
  return NodeChildProcess.spawn(
    runnerPath,
    ["serve", "--host", "127.0.0.1", "--port", String(port), "--base-dir", harness.baseDir],
    {
      detached: true,
      env: {
        ...process.env,
        ...(serviceManaged ? { FAKE_SERVICE_MANAGED: "1" } : {}),
        ...(waitForRuntime ? { FAKE_WAIT_FOR_RUNTIME: "1" } : {}),
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
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

function stopTestProvider(harness: Harness): void {
  const providerPath = NodePath.join(harness.baseDir, "provider.pid");
  if (!NodeFS.existsSync(providerPath)) return;
  try {
    process.kill(-Number(NodeFS.readFileSync(providerPath, "utf8")), "SIGKILL");
  } catch {}
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

it.each([false, true])(
  "waits for a service update instead of launching a competing server (previous server live: %s)",
  async (previousLive) => {
    const harness = makeHarness();
    const oldRunner = writeRunner(harness, "previous.sh", "1.2.3");
    const candidate = writeRunner(harness, "candidate.sh", "1.2.3");
    const replacementRunner = writeRunner(harness, "service.sh", "1.2.4");
    const port = await reservePort();
    const previous = previousLive ? spawnFakeServer(harness, oldRunner, port, true) : undefined;
    let replacement: NodeChildProcess.ChildProcess | undefined;
    try {
      if (previous !== undefined) {
        await NodeEvents.EventEmitter.once(previous, "message");
        stopTestProvider(harness);
      }
      const serviceStatePath = NodePath.join(harness.baseDir, "runtime", "service-state.json");
      NodeFS.mkdirSync(NodePath.dirname(serviceStatePath), { recursive: true });
      NodeFS.writeFileSync(
        serviceStatePath,
        JSON.stringify({
          protocol: 3,
          activeVersion: "1.2.3",
          update: {
            id: "test-update",
            fromVersion: "1.2.3",
            targetVersion: "1.2.4",
            dbPath: NodePath.join(harness.baseDir, "userdata", "statev2.sqlite"),
            status: "pending",
          },
        }),
      );
      assert.deepEqual(
        await probeSshServer({
          stateRoot: harness.stateRoot,
          ownerKey: OWNER_KEY,
          expectedVersion: "1.2.3",
          runnerId: "older-client",
          baseDir: harness.baseDir,
        }),
        { status: "needs-ensure" },
      );
      const ensuring = ensureSshServer({
        stateRoot: harness.stateRoot,
        ownerKey: OWNER_KEY,
        expectedVersion: "1.2.3",
        runnerId: "older-client",
        candidateRunnerPath: candidate,
        stableRunnerPath: harness.stableRunnerPath,
        baseDir: harness.baseDir,
        defaultPort: port,
      });
      // Attach the rejection handler before starting the service's replacement.
      const result = Promise.allSettled([ensuring]);
      replacement = spawnFakeServer(harness, replacementRunner, await reservePort(), true);
      await NodeEvents.EventEmitter.once(replacement, "message");
      const [outcome] = await result;
      if (outcome.status === "rejected") throw outcome.reason;
      const ensured = outcome.value;
      const replacementPid = replacement.pid;
      if (replacementPid === undefined) throw new Error("Service replacement has no PID.");
      assert.deepInclude(ensured, {
        decision: "reuse-external",
        serverKind: "external",
        remotePid: replacementPid,
        serverVersion: "1.2.4",
      });
      assert.isTrue(processExists(replacementPid));
      assert.deepEqual(
        await stopSshServer({
          stateRoot: harness.stateRoot,
          ownerKey: OWNER_KEY,
          baseDir: harness.baseDir,
        }),
        { stopped: false },
      );
    } finally {
      await stopSshServer({
        stateRoot: harness.stateRoot,
        ownerKey: OWNER_KEY,
        baseDir: harness.baseDir,
      });
      if (previous !== undefined) await stopTestProcess(previous);
      if (replacement !== undefined) await stopTestProcess(replacement);
      stopTestProvider(harness);
      NodeFS.rmSync(harness.root, { recursive: true, force: true });
    }
  },
  20_000,
);

it("waits for a committed service child to publish its runtime", async () => {
  const harness = makeHarness();
  const runner = writeRunner(harness, "candidate.sh", "1.2.3");
  const serviceRunner = writeRunner(harness, "service.sh", "1.2.4");
  const child = spawnFakeServer(harness, serviceRunner, await reservePort(), true, true);
  const runtimePending = NodeEvents.EventEmitter.once(child, "message");
  try {
    const childPid = child.pid;
    if (childPid === undefined) throw new Error("Service replacement has no PID.");
    const runtimeDir = NodePath.join(harness.baseDir, "runtime");
    NodeFS.mkdirSync(runtimeDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(runtimeDir, "service-state.json"),
      JSON.stringify({
        protocol: 3,
        activeVersion: "1.2.4",
      }),
    );
    const stateDir = NodePath.join(harness.baseDir, "userdata");
    NodeFS.mkdirSync(stateDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(stateDir, "server.lock"),
      JSON.stringify({
        version: 1,
        pid: childPid,
        startedAt: new Date().toISOString(),
      }),
    );
    await runtimePending;
    const ready = NodeEvents.EventEmitter.once(child, "message");
    const ensuring = ensureSshServer({
      stateRoot: harness.stateRoot,
      ownerKey: OWNER_KEY,
      expectedVersion: "1.2.3",
      runnerId: "older-client",
      candidateRunnerPath: runner,
      stableRunnerPath: harness.stableRunnerPath,
      baseDir: harness.baseDir,
    });
    const result = Promise.allSettled([ensuring]);
    child.send({ type: "publish-runtime" });
    await ready;
    const [outcome] = await result;
    if (outcome.status === "rejected") throw outcome.reason;
    assert.deepInclude(outcome.value, {
      remotePid: childPid,
      serverVersion: "1.2.4",
      decision: "reuse-external",
    });
  } finally {
    await stopSshServer({
      stateRoot: harness.stateRoot,
      ownerKey: OWNER_KEY,
      baseDir: harness.baseDir,
    });
    await stopTestProcess(child);
    stopTestProvider(harness);
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

it("does not replace a service-managed server whose descriptor is temporarily unresponsive", async () => {
  const harness = makeHarness();
  const port = await reservePort();
  const child = spawnFakeServer(
    harness,
    writeRunner(harness, "service-runner.sh", "1.2.3"),
    port,
    true,
  );
  let unexpectedReplacementPid: number | undefined;
  try {
    await waitForFile(NodePath.join(harness.baseDir, "userdata", "server-runtime.json"));
    const pid = child.pid;
    assert.isDefined(pid);
    await ensureSshServer({
      stateRoot: harness.stateRoot,
      ownerKey: OWNER_KEY,
      expectedVersion: "1.2.3",
      runnerId: "runner-one",
      candidateRunnerPath: writeRunner(harness, "candidate-first.sh", "1.2.3"),
      stableRunnerPath: harness.stableRunnerPath,
      baseDir: harness.baseDir,
    });
    const statePath = NodePath.join(harness.stateRoot, "server-state.json");
    const stateBeforeFailure = NodeFS.readFileSync(statePath, "utf8");
    const runnerBeforeFailure = NodeFS.readFileSync(harness.stableRunnerPath, "utf8");
    const replacementCandidate = writeRunner(harness, "candidate-second.sh", "1.2.3");
    NodeFS.writeFileSync(NodePath.join(harness.baseDir, "delayed-descriptor.pid"), String(pid));

    const input = {
      stateRoot: harness.stateRoot,
      ownerKey: OWNER_KEY,
      expectedVersion: "1.2.3",
      runnerId: "runner-one",
      candidateRunnerPath: replacementCandidate,
      stableRunnerPath: harness.stableRunnerPath,
      baseDir: harness.baseDir,
    } as const;
    await expect(
      ensureSshServer(input).then((result) => {
        unexpectedReplacementPid = result.remotePid;
        return result;
      }),
    ).rejects.toThrow("refusing to start a competing server");

    assert.isTrue(processExists(pid));
    assert.equal(NodeFS.readFileSync(statePath, "utf8"), stateBeforeFailure);
    assert.equal(NodeFS.readFileSync(harness.stableRunnerPath, "utf8"), runnerBeforeFailure);
    assert.isTrue(NodeFS.existsSync(replacementCandidate));
  } finally {
    if (unexpectedReplacementPid !== undefined) {
      try {
        process.kill(-unexpectedReplacementPid, "SIGKILL");
      } catch {}
    }
    stopTestProvider(harness);
    await stopTestProcess(child);
    NodeFS.rmSync(harness.root, { recursive: true, force: true });
  }
}, 20_000);

it("recovers a stale runtime whose recorded process has no server listener", async () => {
  const harness = makeHarness();
  const port = await reservePort();
  const staleProcess = NodeChildProcess.spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { detached: true, stdio: "ignore" },
  );
  let activePid: number | undefined;
  try {
    const stalePid = staleProcess.pid;
    assert.isDefined(stalePid);
    const runtimePath = NodePath.join(harness.baseDir, "userdata", "server-runtime.json");
    NodeFS.mkdirSync(NodePath.dirname(runtimePath), { recursive: true });
    NodeFS.writeFileSync(
      runtimePath,
      `${JSON.stringify({
        version: 1,
        pid: stalePid,
        port,
        origin: `http://127.0.0.1:${String(port)}`,
        startedAt: new Date().toISOString(),
        serviceManaged: true,
      })}\n`,
    );

    const recovered = await ensureSshServer({
      stateRoot: harness.stateRoot,
      ownerKey: OWNER_KEY,
      expectedVersion: "1.2.3",
      runnerId: "runner-one",
      candidateRunnerPath: writeRunner(harness, "candidate.sh", "1.2.3"),
      stableRunnerPath: harness.stableRunnerPath,
      baseDir: harness.baseDir,
      defaultPort: port,
    });
    activePid = recovered.remotePid;

    assert.equal(recovered.decision, "cold-start");
    assert.equal(recovered.remotePort, port);
    assert.notEqual(recovered.remotePid, stalePid);
    assert.isTrue(processExists(stalePid));

    assert.deepEqual(
      await stopSshServer({
        stateRoot: harness.stateRoot,
        ownerKey: OWNER_KEY,
        baseDir: harness.baseDir,
      }),
      { stopped: true },
    );
    activePid = undefined;
  } finally {
    if (activePid !== undefined) {
      try {
        process.kill(-activePid, "SIGKILL");
      } catch {}
    }
    stopTestProvider(harness);
    await stopTestProcess(staleProcess);
    NodeFS.rmSync(harness.root, { recursive: true, force: true });
  }
}, 20_000);

it("reuses an owned server that responds during the overload grace", async () => {
  const harness = makeHarness();
  const port = await reservePort();
  let activePid: number | undefined;
  try {
    const first = await ensureSshServer({
      stateRoot: harness.stateRoot,
      ownerKey: OWNER_KEY,
      expectedVersion: "1.2.3",
      runnerId: "runner-one",
      candidateRunnerPath: writeRunner(harness, "candidate-first.sh", "1.2.3"),
      stableRunnerPath: harness.stableRunnerPath,
      baseDir: harness.baseDir,
      defaultPort: port,
    });
    activePid = first.remotePid;
    NodeFS.writeFileSync(
      NodePath.join(harness.baseDir, "delayed-descriptor.pid"),
      String(first.remotePid),
    );

    const recovered = await ensureSshServer({
      stateRoot: harness.stateRoot,
      ownerKey: OWNER_KEY,
      expectedVersion: "1.2.3",
      runnerId: "runner-one",
      candidateRunnerPath: writeRunner(harness, "candidate-second.sh", "1.2.3"),
      stableRunnerPath: harness.stableRunnerPath,
      baseDir: harness.baseDir,
      defaultPort: port,
    });
    activePid = recovered.remotePid;

    assert.equal(recovered.decision, "reuse-managed");
    assert.equal(recovered.remotePort, first.remotePort);
    assert.equal(recovered.remotePid, first.remotePid);
    assert.isTrue(processExists(first.remotePid));

    assert.deepEqual(
      await stopSshServer({
        stateRoot: harness.stateRoot,
        ownerKey: OWNER_KEY,
        baseDir: harness.baseDir,
      }),
      { stopped: true },
    );
    activePid = undefined;
  } finally {
    if (activePid !== undefined) {
      try {
        process.kill(-activePid, "SIGKILL");
      } catch {}
    }
    stopTestProvider(harness);
    NodeFS.rmSync(harness.root, { recursive: true, force: true });
  }
}, 30_000);

it("restarts an owned server only after the overload grace is exhausted", async () => {
  const harness = makeHarness();
  const port = await reservePort();
  let activePid: number | undefined;
  try {
    const first = await ensureSshServer({
      stateRoot: harness.stateRoot,
      ownerKey: OWNER_KEY,
      expectedVersion: "1.2.3",
      runnerId: "runner-one",
      candidateRunnerPath: writeRunner(harness, "candidate-first.sh", "1.2.3"),
      stableRunnerPath: harness.stableRunnerPath,
      baseDir: harness.baseDir,
      defaultPort: port,
    });
    activePid = first.remotePid;
    NodeFS.writeFileSync(
      NodePath.join(harness.baseDir, "unresponsive-descriptor.pid"),
      String(first.remotePid),
    );

    const replacement = await ensureSshServer({
      stateRoot: harness.stateRoot,
      ownerKey: OWNER_KEY,
      expectedVersion: "1.2.3",
      runnerId: "runner-one",
      candidateRunnerPath: writeRunner(harness, "candidate-second.sh", "1.2.3"),
      stableRunnerPath: harness.stableRunnerPath,
      baseDir: harness.baseDir,
      defaultPort: port,
    });
    activePid = replacement.remotePid;

    assert.equal(replacement.decision, "restart-unhealthy");
    assert.equal(replacement.remotePort, first.remotePort);
    assert.notEqual(replacement.remotePid, first.remotePid);
    assert.isFalse(processExists(first.remotePid));
    assert.isTrue(processExists(replacement.remotePid));

    assert.deepEqual(
      await stopSshServer({
        stateRoot: harness.stateRoot,
        ownerKey: OWNER_KEY,
        baseDir: harness.baseDir,
      }),
      { stopped: true },
    );
    activePid = undefined;
  } finally {
    if (activePid !== undefined) {
      try {
        process.kill(-activePid, "SIGKILL");
      } catch {}
    }
    stopTestProvider(harness);
    NodeFS.rmSync(harness.root, { recursive: true, force: true });
  }
}, 40_000);

it("preserves another connection's legacy ownership during migration", async () => {
  const harness = makeHarness();
  const otherOwnerKey = "fedcba9876543210";
  const runner = writeRunner(harness, "legacy-runner.sh", "1.2.3");
  const port = await reservePort();
  const child = spawnFakeServer(harness, runner, port);
  try {
    await waitForFile(NodePath.join(harness.baseDir, "userdata", "server-runtime.json"));
    const pid = child.pid;
    assert.isDefined(pid);
    const legacy = NodePath.join(harness.stateRoot, OWNER_KEY);
    NodeFS.mkdirSync(legacy, { recursive: true });
    NodeFS.copyFileSync(runner, NodePath.join(legacy, "run-t3.sh"));
    NodeFS.writeFileSync(NodePath.join(legacy, "pid"), `${String(pid)}\n`);
    NodeFS.writeFileSync(NodePath.join(legacy, "port"), `${String(port)}\n`);
    NodeFS.writeFileSync(NodePath.join(legacy, "managed"), "managed\n");

    const ensured = await ensureSshServer({
      stateRoot: harness.stateRoot,
      ownerKey: otherOwnerKey,
      expectedVersion: "1.2.3",
      runnerId: "other-runner",
      candidateRunnerPath: writeRunner(harness, "candidate-other.sh", "1.2.3"),
      stableRunnerPath: harness.stableRunnerPath,
      baseDir: harness.baseDir,
    });
    assert.deepInclude(ensured, {
      decision: "reuse-external",
      serverKind: "external",
      remotePid: pid,
    });
    const state = JSON.parse(
      NodeFS.readFileSync(NodePath.join(harness.stateRoot, "server-state.json"), "utf8"),
    ) as { kind?: string; ownerKey?: string };
    assert.deepInclude(state, { kind: "managed", ownerKey: OWNER_KEY });
    assert.deepEqual(
      await stopSshServer({
        stateRoot: harness.stateRoot,
        ownerKey: otherOwnerKey,
        baseDir: harness.baseDir,
      }),
      { stopped: false },
    );

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
  } finally {
    await stopTestProcess(child);
    NodeFS.rmSync(harness.root, { recursive: true, force: true });
  }
}, 20_000);

it("keeps the winning owner when different connections race a cold start", async () => {
  const harness = makeHarness();
  const otherOwnerKey = "fedcba9876543210";
  const port = await reservePort();
  let remotePid: number | undefined;
  try {
    const attempts = [
      {
        ownerKey: OWNER_KEY,
        candidateRunnerPath: writeRunner(harness, "candidate-owner-one.sh", "1.2.3"),
      },
      {
        ownerKey: otherOwnerKey,
        candidateRunnerPath: writeRunner(harness, "candidate-owner-two.sh", "1.2.3"),
      },
    ] as const;
    const results = await Promise.all(
      attempts.map((attempt) =>
        ensureSshServer({
          stateRoot: harness.stateRoot,
          ownerKey: attempt.ownerKey,
          expectedVersion: "1.2.3",
          runnerId: "runner-one",
          candidateRunnerPath: attempt.candidateRunnerPath,
          stableRunnerPath: harness.stableRunnerPath,
          baseDir: harness.baseDir,
          defaultPort: port,
        }),
      ),
    );
    const winningIndex = results.findIndex((result) => result.serverKind === "managed");
    const losingIndex = results.findIndex((result) => result.serverKind === "external");
    assert.notEqual(winningIndex, -1);
    assert.notEqual(losingIndex, -1);
    const winner = results[winningIndex];
    const loser = results[losingIndex];
    const winningAttempt = attempts[winningIndex];
    const losingAttempt = attempts[losingIndex];
    assert.isDefined(winner);
    assert.isDefined(loser);
    assert.isDefined(winningAttempt);
    assert.isDefined(losingAttempt);
    remotePid = winner.remotePid;
    assert.equal(winner.decision, "cold-start");
    assert.equal(loser.decision, "reuse-external");
    assert.equal(loser.remotePid, winner.remotePid);

    const state = JSON.parse(
      NodeFS.readFileSync(NodePath.join(harness.stateRoot, "server-state.json"), "utf8"),
    ) as { kind?: string; ownerKey?: string };
    assert.deepInclude(state, {
      kind: "managed",
      ownerKey: winningAttempt.ownerKey,
    });
    assert.deepEqual(
      await stopSshServer({
        stateRoot: harness.stateRoot,
        ownerKey: losingAttempt.ownerKey,
        baseDir: harness.baseDir,
      }),
      { stopped: false },
    );
    assert.isTrue(processExists(winner.remotePid));
    assert.deepEqual(
      await stopSshServer({
        stateRoot: harness.stateRoot,
        ownerKey: winningAttempt.ownerKey,
        baseDir: harness.baseDir,
      }),
      { stopped: true },
    );
    remotePid = undefined;
  } finally {
    if (remotePid !== undefined) {
      try {
        process.kill(-remotePid, "SIGKILL");
      } catch {}
    }
    const providerPath = NodePath.join(harness.baseDir, "provider.pid");
    if (NodeFS.existsSync(providerPath)) {
      try {
        process.kill(Number(NodeFS.readFileSync(providerPath, "utf8")), "SIGKILL");
      } catch {}
    }
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
