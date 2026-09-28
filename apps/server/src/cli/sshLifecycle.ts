// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
import * as NodeChildProcess from "node:child_process";
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { compareExactServiceVersions, isExactServiceVersion } from "../cloud/serviceProtocol.ts";
import { PersistedServerRuntimeState } from "../serverRuntimeState.ts";

const DEFAULT_REMOTE_PORT = 3773;
const REMOTE_PORT_SCAN_WINDOW = 200;
const LOCK_TIMEOUT_MS = 90_000;
const LOCK_OWNER_GRACE_MS = 2_000;
const READY_TIMEOUT_MS = 60_000;
const READY_PROBE_TIMEOUT_MS = 1_000;
const STOP_GRACE_MS = 5_000;
const POLL_INTERVAL_MS = 100;

const ManagedServerState = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("managed"),
  ownerKey: Schema.String,
  pid: Schema.Int,
  processStartToken: Schema.String,
  processGroupId: Schema.optional(Schema.Int),
  port: Schema.Int,
  runnerId: Schema.String,
  serverStartedAt: Schema.optional(Schema.String),
  serverVersion: Schema.optional(Schema.String),
});

const ExternalServerState = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("external"),
  pid: Schema.Int,
  processStartToken: Schema.String,
  port: Schema.Int,
  serverStartedAt: Schema.String,
  serverVersion: Schema.String,
});

const SshServerState = Schema.Union([ManagedServerState, ExternalServerState]);
type SshServerState = typeof SshServerState.Type;
type ManagedServerState = typeof ManagedServerState.Type;

const LockOwner = Schema.Struct({
  version: Schema.Literal(1),
  token: Schema.String,
  pid: Schema.Int,
  processStartToken: Schema.String,
});
type LockOwner = typeof LockOwner.Type;

interface LockObservation {
  readonly owner: LockOwner | undefined;
  readonly device: number;
  readonly inode: number;
  readonly modifiedAt: number;
}

const decodeServerState = Schema.decodeUnknownOption(Schema.fromJsonString(SshServerState));
const encodeServerState = Schema.encodeSync(Schema.fromJsonString(SshServerState));
const decodeLockOwner = Schema.decodeUnknownOption(Schema.fromJsonString(LockOwner));
const encodeLockOwner = Schema.encodeSync(Schema.fromJsonString(LockOwner));
const decodeRuntimeState = Schema.decodeUnknownOption(
  Schema.fromJsonString(PersistedServerRuntimeState),
);
const decodeEnvironmentDescriptor = Schema.decodeUnknownOption(ExecutionEnvironmentDescriptor);

export type SshLifecycleDecision =
  | "reuse-managed"
  | "reuse-external"
  | "upgrade-managed"
  | "restart-unhealthy"
  | "cold-start";

export interface SshLifecycleReadyResult {
  readonly status: "ready";
  readonly remotePort: number;
  readonly serverKind: "external" | "managed";
  readonly decision: SshLifecycleDecision;
  readonly remotePid: number;
  readonly serverVersion: string;
}

export interface SshLifecycleNeedsEnsureResult {
  readonly status: "needs-ensure";
}

export type SshLifecycleProbeResult = SshLifecycleReadyResult | SshLifecycleNeedsEnsureResult;

export interface EnsureSshServerInput {
  readonly stateRoot: string;
  readonly ownerKey: string;
  readonly expectedVersion: string;
  readonly runnerId: string;
  readonly candidateRunnerPath: string;
  readonly stableRunnerPath: string;
  readonly baseDir: string;
  /** Test-only port preference; production starts at the standard SSH port. */
  readonly defaultPort?: number;
}

export interface ProbeSshServerInput {
  readonly stateRoot: string;
  readonly ownerKey: string;
  readonly expectedVersion: string;
  readonly runnerId: string;
  readonly baseDir: string;
}

export interface StopSshServerInput {
  readonly stateRoot: string;
  readonly ownerKey: string;
  readonly baseDir: string;
}

interface ProcessIdentity {
  readonly startToken: string;
  readonly zombie: boolean;
  readonly parentPid: number;
  readonly processGroupId: number;
}

interface LiveServer {
  readonly runtime: PersistedServerRuntimeState;
  readonly process: ProcessIdentity;
  readonly descriptor: ExecutionEnvironmentDescriptor;
}

interface SshLifecyclePaths {
  readonly stateRoot: string;
  readonly statePath: string;
  readonly lockPath: string;
  readonly logPath: string;
  readonly runtimePath: string;
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function lifecyclePaths(stateRoot: string, baseDir: string): SshLifecyclePaths {
  return {
    stateRoot,
    statePath: NodePath.join(stateRoot, "server-state.json"),
    lockPath: NodePath.join(stateRoot, "server-state.lock"),
    logPath: NodePath.join(stateRoot, "server.log"),
    runtimePath: NodePath.join(baseDir, "userdata", "server-runtime.json"),
  };
}

function validateOwnerKey(ownerKey: string): void {
  if (!/^[a-f0-9]{16}$/u.test(ownerKey)) {
    throw new Error("SSH lifecycle owner key is invalid.");
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function readLinuxProcessIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const stat = NodeFS.readFileSync(`/proc/${String(pid)}/stat`, "utf8").trim();
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return undefined;
    const fields = stat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/u);
    const processState = fields[0];
    const parentPid = Number(fields[1]);
    const processGroupId = Number(fields[2]);
    const startTime = fields[19];
    if (
      processState === undefined ||
      startTime === undefined ||
      !Number.isInteger(parentPid) ||
      !Number.isInteger(processGroupId)
    ) {
      return undefined;
    }
    return {
      startToken: `linux:${startTime}`,
      zombie: processState === "Z",
      parentPid,
      processGroupId,
    };
  } catch {
    return undefined;
  }
}

function readDarwinProcessIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const output = NodeChildProcess.execFileSync(
      "ps",
      ["-o", "ppid=", "-o", "pgid=", "-o", "stat=", "-o", "lstart=", "-p", String(pid)],
      { encoding: "utf8" },
    ).trim();
    const [rawParentPid, rawProcessGroupId, status, ...startedAtParts] = output.split(/\s+/u);
    const parentPid = Number(rawParentPid);
    const processGroupId = Number(rawProcessGroupId);
    const startedAt = startedAtParts.join(" ");
    if (
      status === undefined ||
      startedAt.length === 0 ||
      !Number.isInteger(parentPid) ||
      !Number.isInteger(processGroupId)
    ) {
      return undefined;
    }
    return {
      startToken: `darwin:${startedAt}`,
      zombie: status.includes("Z"),
      parentPid,
      processGroupId,
    };
  } catch {
    return undefined;
  }
}

export function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (!Number.isInteger(pid) || pid <= 0 || !processExists(pid)) return undefined;
  const platform = HostProcessPlatform.defaultValue();
  if (platform === "linux") return readLinuxProcessIdentity(pid);
  if (platform === "darwin") return readDarwinProcessIdentity(pid);
  return undefined;
}

function readProcessTable(): ReadonlyMap<number, ProcessIdentity> {
  const table = new Map<number, ProcessIdentity>();
  const platform = HostProcessPlatform.defaultValue();
  if (platform === "linux") {
    for (const entry of NodeFS.readdirSync("/proc")) {
      if (!/^\d+$/u.test(entry)) continue;
      const pid = Number(entry);
      const identity = readLinuxProcessIdentity(pid);
      if (identity !== undefined) table.set(pid, identity);
    }
    return table;
  }
  if (platform === "darwin") {
    const output = NodeChildProcess.execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="], {
      encoding: "utf8",
    });
    for (const line of output.split(/\r?\n/u)) {
      const [rawPid, rawParentPid, rawProcessGroupId, status, ...startedAtParts] = line
        .trim()
        .split(/\s+/u);
      const pid = Number(rawPid);
      const parentPid = Number(rawParentPid);
      const processGroupId = Number(rawProcessGroupId);
      const startedAt = startedAtParts.join(" ");
      if (
        status === undefined ||
        startedAt.length === 0 ||
        !Number.isInteger(pid) ||
        !Number.isInteger(parentPid) ||
        !Number.isInteger(processGroupId)
      ) {
        continue;
      }
      table.set(pid, {
        startToken: `darwin:${startedAt}`,
        zombie: status.includes("Z"),
        parentPid,
        processGroupId,
      });
    }
  }
  return table;
}

function collectDescendantProcesses(
  rootPid: number,
): ReadonlyArray<{ readonly pid: number; readonly identity: ProcessIdentity }> {
  const table = readProcessTable();
  const descendants: Array<{ readonly pid: number; readonly identity: ProcessIdentity }> = [];
  const parents = [rootPid];
  for (let index = 0; index < parents.length; index += 1) {
    const parentPid = parents[index];
    for (const [pid, identity] of table) {
      if (identity.parentPid !== parentPid || pid === rootPid) continue;
      descendants.push({ pid, identity });
      parents.push(pid);
    }
  }
  return descendants;
}

function readServerState(statePath: string): SshServerState | undefined {
  try {
    return Option.getOrUndefined(decodeServerState(NodeFS.readFileSync(statePath, "utf8")));
  } catch {
    return undefined;
  }
}

function readLockOwner(lockPath: string): LockOwner | undefined {
  try {
    return Option.getOrUndefined(
      decodeLockOwner(NodeFS.readFileSync(NodePath.join(lockPath, "owner.json"), "utf8")),
    );
  } catch {
    return undefined;
  }
}

function writeFileAtomically(filePath: string, contents: string): void {
  const directory = NodePath.dirname(filePath);
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = NodePath.join(
    directory,
    `.${NodePath.basename(filePath)}.${String(process.pid)}.${NodeCrypto.randomUUID()}`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = NodeFS.openSync(temporaryPath, "wx", 0o600);
    NodeFS.writeFileSync(descriptor, contents, "utf8");
    NodeFS.fsyncSync(descriptor);
    NodeFS.closeSync(descriptor);
    descriptor = undefined;
    NodeFS.renameSync(temporaryPath, filePath);
    const directoryDescriptor = NodeFS.openSync(directory, "r");
    try {
      NodeFS.fsyncSync(directoryDescriptor);
    } finally {
      NodeFS.closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) NodeFS.closeSync(descriptor);
    NodeFS.rmSync(temporaryPath, { force: true });
  }
}

function writeServerState(statePath: string, state: SshServerState): void {
  writeFileAtomically(statePath, `${encodeServerState(state)}\n`);
}

function lockOwnerIsAlive(owner: LockOwner): boolean {
  const identity = readProcessIdentity(owner.pid);
  return (
    identity !== undefined && !identity.zombie && identity.startToken === owner.processStartToken
  );
}

function observeLifecycleLock(lockPath: string): LockObservation | undefined {
  try {
    const stats = NodeFS.statSync(lockPath);
    return {
      owner: readLockOwner(lockPath),
      device: stats.dev,
      inode: stats.ino,
      modifiedAt: stats.mtimeMs,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function reclaimLifecycleLock(lockPath: string, observed: LockObservation): boolean {
  const claimPath = NodePath.join(lockPath, ".reclaim");
  try {
    NodeFS.mkdirSync(claimPath, { mode: 0o700 });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "EEXIST" || error.code === "ENOENT")
    ) {
      return false;
    }
    throw error;
  }

  try {
    const currentStats = NodeFS.statSync(lockPath);
    const currentOwner = readLockOwner(lockPath);
    const stillStale =
      observed.owner === undefined
        ? currentOwner === undefined &&
          currentStats.dev === observed.device &&
          currentStats.ino === observed.inode &&
          Date.now() - observed.modifiedAt >= LOCK_OWNER_GRACE_MS
        : currentOwner?.token === observed.owner.token && !lockOwnerIsAlive(currentOwner);
    if (!stillStale) return false;
    NodeFS.rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  } finally {
    NodeFS.rmSync(claimPath, { recursive: true, force: true });
  }
}

async function withLifecycleLock<A>(paths: SshLifecyclePaths, body: () => Promise<A>): Promise<A> {
  NodeFS.mkdirSync(paths.stateRoot, { recursive: true, mode: 0o700 });
  const identity = readProcessIdentity(process.pid);
  if (identity === undefined || identity.zombie) {
    throw new Error("Could not identify the SSH lifecycle helper process.");
  }
  const owner: LockOwner = {
    version: 1,
    token: NodeCrypto.randomUUID(),
    pid: process.pid,
    processStartToken: identity.startToken,
  };
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      NodeFS.mkdirSync(paths.lockPath, { mode: 0o700 });
      writeFileAtomically(
        NodePath.join(paths.lockPath, "owner.json"),
        `${encodeLockOwner(owner)}\n`,
      );
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const observed = observeLifecycleLock(paths.lockPath);
      if (observed !== undefined && reclaimLifecycleLock(paths.lockPath, observed)) continue;
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for another SSH server lifecycle operation.", {
          cause: error,
        });
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  try {
    return await body();
  } finally {
    const current = readLockOwner(paths.lockPath);
    if (current?.token === owner.token) {
      NodeFS.rmSync(paths.lockPath, { recursive: true, force: true });
    }
  }
}

function readRuntimeState(runtimePath: string): PersistedServerRuntimeState | undefined {
  try {
    const state = Option.getOrUndefined(
      decodeRuntimeState(NodeFS.readFileSync(runtimePath, "utf8")),
    );
    if (state === undefined) return undefined;
    const origin = new URL(state.origin);
    if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname)) {
      return undefined;
    }
    return state;
  } catch {
    return undefined;
  }
}

function fetchEnvironmentDescriptor(
  origin: string,
  timeoutMs: number,
): Promise<ExecutionEnvironmentDescriptor | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: ExecutionEnvironmentDescriptor | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let endpoint: URL;
    try {
      endpoint = new URL("/.well-known/t3/environment", origin);
    } catch {
      finish(undefined);
      return;
    }
    const request = NodeHttp.get(endpoint, { timeout: timeoutMs }, (response) => {
      response.once("error", () => finish(undefined));
      if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
        response.resume();
        finish(undefined);
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 64 * 1024) request.destroy();
      });
      response.once("end", () => {
        try {
          const parsed: unknown = JSON.parse(body);
          finish(Option.getOrUndefined(decodeEnvironmentDescriptor(parsed)));
        } catch {
          finish(undefined);
        }
      });
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => finish(undefined));
  });
}

async function inspectLiveServer(runtimePath: string): Promise<LiveServer | undefined> {
  const runtime = readRuntimeState(runtimePath);
  if (runtime === undefined) return undefined;
  const identity = readProcessIdentity(runtime.pid);
  if (identity === undefined || identity.zombie) return undefined;
  const descriptor = await fetchEnvironmentDescriptor(runtime.origin, READY_PROBE_TIMEOUT_MS);
  if (descriptor === undefined) return undefined;
  return { runtime, process: identity, descriptor };
}

function stateMatchesLiveServer(state: SshServerState, live: LiveServer): boolean {
  return (
    state.pid === live.runtime.pid &&
    state.port === live.runtime.port &&
    state.processStartToken === live.process.startToken &&
    (state.kind === "external" ||
      state.serverStartedAt === undefined ||
      state.serverStartedAt === live.runtime.startedAt)
  );
}

function runnerIsCompatible(
  expectedVersion: string,
  runnerId: string,
  state: ManagedServerState,
  live: LiveServer,
): boolean {
  if (expectedVersion.length === 0) return state.runnerId === runnerId;
  const runningVersion = live.descriptor.serverVersion;
  if (runningVersion === expectedVersion) return true;
  // Released runtimes move monotonically. An older client can reuse a newer
  // compatible server, but it must never roll the host backward and make a
  // newer client upgrade it again on the next connection.
  return (
    isExactServiceVersion(runningVersion) &&
    isExactServiceVersion(expectedVersion) &&
    compareExactServiceVersions(runningVersion, expectedVersion) > 0
  );
}

function readyResult(
  live: LiveServer,
  serverKind: "external" | "managed",
  decision: SshLifecycleDecision,
): SshLifecycleReadyResult {
  return {
    status: "ready",
    remotePort: live.runtime.port,
    serverKind,
    decision,
    remotePid: live.runtime.pid,
    serverVersion: live.descriptor.serverVersion,
  };
}

function readLegacyRunnerId(legacyRoot: string): string {
  try {
    return NodeCrypto.createHash("sha256")
      .update(NodeFS.readFileSync(NodePath.join(legacyRoot, "run-t3.sh"), "utf8"))
      .digest("hex");
  } catch {
    return "";
  }
}

function readLegacyManagedState(
  paths: SshLifecyclePaths,
  ownerKey: string,
  live: LiveServer | undefined,
): ManagedServerState | undefined {
  if (live === undefined) return undefined;
  const legacyRoot = NodePath.join(paths.stateRoot, ownerKey);
  try {
    const managed = NodeFS.readFileSync(NodePath.join(legacyRoot, "managed"), "utf8").trim();
    const pid = Number.parseInt(
      NodeFS.readFileSync(NodePath.join(legacyRoot, "pid"), "utf8").trim(),
      10,
    );
    const port = Number.parseInt(
      NodeFS.readFileSync(NodePath.join(legacyRoot, "port"), "utf8").trim(),
      10,
    );
    if (managed !== "managed" || pid !== live.runtime.pid || port !== live.runtime.port) {
      return undefined;
    }
    return {
      version: 1,
      kind: "managed",
      ownerKey,
      pid,
      processStartToken: live.process.startToken,
      processGroupId: live.process.processGroupId,
      port,
      runnerId: readLegacyRunnerId(legacyRoot),
      serverStartedAt: live.runtime.startedAt,
      serverVersion: live.descriptor.serverVersion,
    };
  } catch {
    return undefined;
  }
}

function findLegacyManagedState(
  paths: SshLifecyclePaths,
  preferredOwnerKey: string,
  live: LiveServer | undefined,
): ManagedServerState | undefined {
  if (live === undefined || live.runtime.serviceManaged) return undefined;
  let ownerKeys: string[];
  try {
    ownerKeys = NodeFS.readdirSync(paths.stateRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{16}$/u.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }
  const orderedOwnerKeys = [
    preferredOwnerKey,
    ...ownerKeys.filter((ownerKey) => ownerKey !== preferredOwnerKey),
  ];
  for (const ownerKey of orderedOwnerKeys) {
    const state = readLegacyManagedState(paths, ownerKey, live);
    if (state !== undefined) return state;
  }
  return undefined;
}

function removeLegacyOwnershipFiles(paths: SshLifecyclePaths, ownerKey: string): void {
  const legacyRoot = NodePath.join(paths.stateRoot, ownerKey);
  for (const name of ["pid", "port", "managed"]) {
    NodeFS.rmSync(NodePath.join(legacyRoot, name), { force: true });
  }
}

function externalStateFrom(live: LiveServer): SshServerState {
  return {
    version: 1,
    kind: "external",
    pid: live.runtime.pid,
    processStartToken: live.process.startToken,
    port: live.runtime.port,
    serverStartedAt: live.runtime.startedAt,
    serverVersion: live.descriptor.serverVersion,
  };
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

interface OwnedProcess {
  readonly pid: number;
  readonly startToken: string;
}

function ownedProcessIsAlive(process: OwnedProcess): boolean {
  const identity = readProcessIdentity(process.pid);
  return identity !== undefined && !identity.zombie && identity.startToken === process.startToken;
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

async function waitForOwnedProcessesExit(
  owned: ReadonlyArray<OwnedProcess>,
  ownedProcessGroupId: number | undefined,
): Promise<boolean> {
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline) {
    if (
      !owned.some(ownedProcessIsAlive) &&
      (ownedProcessGroupId === undefined || !processGroupExists(ownedProcessGroupId))
    ) {
      return true;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return (
    !owned.some(ownedProcessIsAlive) &&
    (ownedProcessGroupId === undefined || !processGroupExists(ownedProcessGroupId))
  );
}

function signalOwnedProcesses(
  owned: ReadonlyArray<OwnedProcess>,
  ownedProcessGroupId: number | undefined,
  signal: NodeJS.Signals,
): void {
  if (ownedProcessGroupId !== undefined) signalProcess(-ownedProcessGroupId, signal);
  // Providers may create their own process groups. Signal every snapshotted
  // descendant as well, deepest first, after verifying its process identity.
  for (const child of owned.slice(1).toReversed()) {
    if (ownedProcessIsAlive(child)) signalProcess(child.pid, signal);
  }
  if (ownedProcessGroupId === undefined && owned[0] !== undefined) {
    if (ownedProcessIsAlive(owned[0])) signalProcess(owned[0].pid, signal);
  }
}

async function stopManagedProcess(state: ManagedServerState): Promise<void> {
  const rootIdentity = readProcessIdentity(state.pid);
  if (rootIdentity !== undefined && rootIdentity.startToken !== state.processStartToken) {
    throw new Error(
      `Refusing to stop PID ${String(state.pid)} because it now belongs to another process.`,
    );
  }
  // New launches are detached and own a group whose id is their pid. Legacy
  // launches inherited the SSH shell's group, which may also contain unrelated
  // host processes, so those are stopped by verified pid and descendants only.
  const processGroupId = state.processGroupId ?? state.pid;
  const ownedProcessGroupId = processGroupId === state.pid ? processGroupId : undefined;
  if (
    rootIdentity === undefined &&
    (ownedProcessGroupId === undefined || !processGroupExists(ownedProcessGroupId))
  ) {
    return;
  }
  const owned: OwnedProcess[] = [
    { pid: state.pid, startToken: state.processStartToken },
    ...collectDescendantProcesses(state.pid).map(({ pid, identity }) => ({
      pid,
      startToken: identity.startToken,
    })),
  ];
  signalOwnedProcesses(owned, ownedProcessGroupId, "SIGTERM");
  if (await waitForOwnedProcessesExit(owned, ownedProcessGroupId)) return;

  // Capture children created while the server was draining before escalation.
  for (const { pid, identity } of collectDescendantProcesses(state.pid)) {
    if (!owned.some((entry) => entry.pid === pid)) {
      owned.push({ pid, startToken: identity.startToken });
    }
  }
  signalOwnedProcesses(owned, ownedProcessGroupId, "SIGKILL");
  if (!(await waitForOwnedProcessesExit(owned, ownedProcessGroupId))) {
    const survivors = owned.filter(ownedProcessIsAlive).map(({ pid }) => pid);
    throw new Error(
      `Remote T3 process tree rooted at ${String(state.pid)} survived SIGKILL${survivors.length === 0 ? "." : ` (PIDs: ${survivors.join(", ")}).`}`,
    );
  }
}

function removeRuntimeStateIfOwned(runtimePath: string, state: ManagedServerState): void {
  const runtime = readRuntimeState(runtimePath);
  if (
    runtime?.pid === state.pid &&
    (state.serverStartedAt === undefined || runtime.startedAt === state.serverStartedAt)
  ) {
    NodeFS.rmSync(runtimePath, { force: true });
  }
}

function promoteRunner(candidateRunnerPath: string, stableRunnerPath: string): void {
  NodeFS.mkdirSync(NodePath.dirname(stableRunnerPath), { recursive: true, mode: 0o700 });
  NodeFS.renameSync(candidateRunnerPath, stableRunnerPath);
  NodeFS.chmodSync(stableRunnerPath, 0o700);
}

const tryPort = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = NodeNet.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => resolve(error === undefined));
    });
  });

async function pickPort(preferred: number | undefined): Promise<number> {
  const start = preferred ?? DEFAULT_REMOTE_PORT;
  for (let port = start; port < start + REMOTE_PORT_SCAN_WINDOW; port += 1) {
    if (await tryPort(port)) return port;
  }
  throw new Error("Failed to find an available port on the remote host.");
}

function readLogTail(logPath: string): string {
  try {
    const size = NodeFS.statSync(logPath).size;
    const length = Math.min(size, 64 * 1024);
    const buffer = NodeBuffer.Buffer.alloc(length);
    const descriptor = NodeFS.openSync(logPath, "r");
    try {
      NodeFS.readSync(descriptor, buffer, 0, length, size - length);
    } finally {
      NodeFS.closeSync(descriptor);
    }
    return buffer.toString("utf8").split(/\r?\n/u).slice(-80).join("\n");
  } catch {
    return "";
  }
}

async function spawnManagedServer(input: {
  readonly paths: SshLifecyclePaths;
  readonly ownerKey: string;
  readonly runnerId: string;
  readonly runnerPath: string;
  readonly baseDir: string;
  readonly preferredPort?: number;
}): Promise<LiveServer> {
  const port = await pickPort(input.preferredPort);
  NodeFS.mkdirSync(NodePath.dirname(input.paths.logPath), { recursive: true, mode: 0o700 });
  const logDescriptor = NodeFS.openSync(input.paths.logPath, "a", 0o600);
  let child: NodeChildProcess.ChildProcess;
  try {
    child = NodeChildProcess.spawn(
      input.runnerPath,
      ["serve", "--host", "127.0.0.1", "--port", String(port), "--base-dir", input.baseDir],
      {
        detached: true,
        env: { ...process.env, T3CODE_NO_BROWSER: "1" },
        stdio: ["ignore", logDescriptor, logDescriptor],
      },
    );
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      child.once("error", onError);
      child.once("spawn", () => {
        child.removeListener("error", onError);
        resolve();
      });
    });
  } finally {
    NodeFS.closeSync(logDescriptor);
  }
  const pid = child.pid;
  if (pid === undefined) throw new Error("Remote T3 server did not report a PID.");

  let identity: ProcessIdentity | undefined;
  const identityDeadline = Date.now() + 2_000;
  while (identity === undefined && Date.now() < identityDeadline) {
    identity = readProcessIdentity(pid);
    if (identity === undefined) await sleep(POLL_INTERVAL_MS);
  }
  if (identity === undefined || identity.zombie) {
    child.kill("SIGKILL");
    throw new Error(`Remote T3 server PID ${String(pid)} exited during launch.`);
  }
  child.unref();

  const launchingState: ManagedServerState = {
    version: 1,
    kind: "managed",
    ownerKey: input.ownerKey,
    pid,
    processStartToken: identity.startToken,
    processGroupId: identity.processGroupId,
    port,
    runnerId: input.runnerId,
  };
  try {
    writeServerState(input.paths.statePath, launchingState);

    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const live = await inspectLiveServer(input.paths.runtimePath);
      if (live !== undefined && live.runtime.pid === pid && live.runtime.port === port) {
        writeServerState(input.paths.statePath, {
          ...launchingState,
          serverStartedAt: live.runtime.startedAt,
          serverVersion: live.descriptor.serverVersion,
        });
        return live;
      }
      const current = readProcessIdentity(pid);
      if (current === undefined || current.zombie || current.startToken !== identity.startToken)
        break;
      await sleep(POLL_INTERVAL_MS);
    }

    const tail = readLogTail(input.paths.logPath);
    throw new Error(
      `Remote T3 server did not become ready on 127.0.0.1:${String(port)}.${tail.length > 0 ? `\n${tail}` : ""}`,
    );
  } catch (cause) {
    try {
      await stopManagedProcess(launchingState);
    } catch (stopCause) {
      // eslint-disable-next-line preserve-caught-error -- Both caught failures are retained as AggregateError members.
      throw new Error(
        `Remote T3 server launch failed and PID ${String(pid)} could not be cleaned up.`,
        { cause: new AggregateError([cause, stopCause]) },
      );
    } finally {
      NodeFS.rmSync(input.paths.statePath, { force: true });
      removeRuntimeStateIfOwned(input.paths.runtimePath, launchingState);
    }
    throw cause;
  }
}

export async function probeSshServer(input: ProbeSshServerInput): Promise<SshLifecycleProbeResult> {
  validateOwnerKey(input.ownerKey);
  const paths = lifecyclePaths(input.stateRoot, input.baseDir);
  const [state, live] = await Promise.all([
    Promise.resolve(readServerState(paths.statePath)),
    inspectLiveServer(paths.runtimePath),
  ]);
  if (live === undefined) return { status: "needs-ensure" };
  if (
    live.runtime.serviceManaged ||
    state?.kind !== "managed" ||
    state.ownerKey !== input.ownerKey ||
    !stateMatchesLiveServer(state, live)
  ) {
    return readyResult(live, "external", "reuse-external");
  }
  return runnerIsCompatible(input.expectedVersion, input.runnerId, state, live)
    ? readyResult(live, "managed", "reuse-managed")
    : { status: "needs-ensure" };
}

export async function ensureSshServer(
  input: EnsureSshServerInput,
): Promise<SshLifecycleReadyResult> {
  validateOwnerKey(input.ownerKey);
  const paths = lifecyclePaths(input.stateRoot, input.baseDir);
  return withLifecycleLock(paths, async () => {
    const live = await inspectLiveServer(paths.runtimePath);
    let state = readServerState(paths.statePath);
    if (
      state === undefined ||
      (state.kind === "external" && live !== undefined && stateMatchesLiveServer(state, live))
    ) {
      const legacyState = findLegacyManagedState(paths, input.ownerKey, live);
      if (legacyState !== undefined) {
        state = legacyState;
        writeServerState(paths.statePath, legacyState);
      }
    }
    if (
      live !== undefined &&
      state?.kind === "managed" &&
      state.ownerKey !== input.ownerKey &&
      stateMatchesLiveServer(state, live)
    ) {
      return readyResult(live, "external", "reuse-external");
    }
    const knownManagedVersion =
      state?.kind === "managed"
        ? (live?.descriptor.serverVersion ?? state.serverVersion)
        : undefined;
    const preserveNewerRunner =
      NodeFS.existsSync(input.stableRunnerPath) &&
      input.expectedVersion.length > 0 &&
      knownManagedVersion !== undefined &&
      isExactServiceVersion(knownManagedVersion) &&
      isExactServiceVersion(input.expectedVersion) &&
      compareExactServiceVersions(knownManagedVersion, input.expectedVersion) > 0;
    if (!preserveNewerRunner) {
      promoteRunner(input.candidateRunnerPath, input.stableRunnerPath);
    }
    const effectiveRunnerId =
      preserveNewerRunner && state?.kind === "managed" ? state.runnerId : input.runnerId;

    if (live !== undefined) {
      if (
        live.runtime.serviceManaged ||
        state?.kind !== "managed" ||
        state.ownerKey !== input.ownerKey ||
        !stateMatchesLiveServer(state, live)
      ) {
        writeServerState(paths.statePath, externalStateFrom(live));
        removeLegacyOwnershipFiles(paths, input.ownerKey);
        return readyResult(live, "external", "reuse-external");
      }
      if (runnerIsCompatible(input.expectedVersion, input.runnerId, state, live)) {
        const refreshed: ManagedServerState = {
          ...state,
          runnerId: effectiveRunnerId,
          serverStartedAt: live.runtime.startedAt,
          serverVersion: live.descriptor.serverVersion,
        };
        writeServerState(paths.statePath, refreshed);
        removeLegacyOwnershipFiles(paths, input.ownerKey);
        return readyResult(live, "managed", "reuse-managed");
      }
      await stopManagedProcess(state);
      removeRuntimeStateIfOwned(paths.runtimePath, state);
      NodeFS.rmSync(paths.statePath, { force: true });
      const replacement = await spawnManagedServer({
        paths,
        ownerKey: input.ownerKey,
        runnerId: effectiveRunnerId,
        runnerPath: input.stableRunnerPath,
        baseDir: input.baseDir,
        preferredPort: state.port,
      });
      removeLegacyOwnershipFiles(paths, input.ownerKey);
      return readyResult(replacement, "managed", "upgrade-managed");
    }

    if (state?.kind === "managed") {
      if (state.ownerKey !== input.ownerKey) {
        const identity = readProcessIdentity(state.pid);
        const processGroupId = state.processGroupId ?? state.pid;
        if (
          identity !== undefined ||
          (processGroupId === state.pid && processGroupExists(processGroupId))
        ) {
          throw new Error(
            `An unhealthy SSH-managed T3 server is owned by another connection (${state.ownerKey}).`,
          );
        }
      } else {
        await stopManagedProcess(state);
        removeRuntimeStateIfOwned(paths.runtimePath, state);
      }
      NodeFS.rmSync(paths.statePath, { force: true });
    }

    const previousPort = state?.port;
    const replacement = await spawnManagedServer({
      paths,
      ownerKey: input.ownerKey,
      runnerId: effectiveRunnerId,
      runnerPath: input.stableRunnerPath,
      baseDir: input.baseDir,
      ...((previousPort ?? input.defaultPort) === undefined
        ? {}
        : { preferredPort: previousPort ?? input.defaultPort }),
    });
    removeLegacyOwnershipFiles(paths, input.ownerKey);
    return readyResult(
      replacement,
      "managed",
      state === undefined || state.kind === "external" ? "cold-start" : "restart-unhealthy",
    );
  });
}

export async function stopSshServer(input: StopSshServerInput): Promise<{ stopped: boolean }> {
  validateOwnerKey(input.ownerKey);
  const paths = lifecyclePaths(input.stateRoot, input.baseDir);
  return withLifecycleLock(paths, async () => {
    let state = readServerState(paths.statePath);
    if (state?.kind !== "managed") {
      const live = await inspectLiveServer(paths.runtimePath);
      if (live !== undefined && (state === undefined || stateMatchesLiveServer(state, live))) {
        state = readLegacyManagedState(paths, input.ownerKey, live) ?? state;
      }
    }
    if (state?.kind !== "managed" || state.ownerKey !== input.ownerKey) {
      return { stopped: false };
    }
    await stopManagedProcess(state);
    removeRuntimeStateIfOwned(paths.runtimePath, state);
    NodeFS.rmSync(paths.statePath, { force: true });
    removeLegacyOwnershipFiles(paths, input.ownerKey);
    return { stopped: true };
  });
}
