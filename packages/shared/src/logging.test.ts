// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as HostProcess from "./HostProcess.ts";

import {
  RotatingFileSink,
  RotatingFileSinkConfigurationError,
  RotatingFileSinkError,
} from "./logging.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const tempDirectories: string[] = [];

const makeTempDirectory = (): string => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-logging-"));
  tempDirectories.push(directory);
  return directory;
};

const captureError = (run: () => unknown): unknown => {
  try {
    run();
  } catch (cause) {
    return cause;
  }
  throw new Error("Expected operation to throw");
};

const captureAsyncError = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (cause) {
    return cause;
  }
  throw new Error("Expected operation to reject");
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("RotatingFileSink", () => {
  it.each([
    { option: "maxBytes" as const, maxBytes: 0, maxFiles: 1 },
    { option: "maxFiles" as const, maxBytes: 1, maxFiles: 0 },
  ])("reports invalid $option configuration structurally", (input) => {
    const thrown = captureError(
      () =>
        new RotatingFileSink({
          filePath: "/unused/log.ndjson",
          maxBytes: input.maxBytes,
          maxFiles: input.maxFiles,
        }),
    );

    expect(thrown).toBeInstanceOf(RotatingFileSinkConfigurationError);
    expect(thrown).toMatchObject({
      option: input.option,
      received: 0,
      minimum: 1,
    });
    expect((thrown as Error).message).toBe(`${input.option} must be >= 1 (received 0)`);
  });

  it("preserves directory initialization failures", async () => {
    const directory = makeTempDirectory();
    const parentFile = NodePath.join(directory, "not-a-directory");
    const filePath = NodePath.join(parentFile, "log.ndjson");
    NodeFS.writeFileSync(parentFile, "occupied");

    const thrown = await captureAsyncError(() =>
      new RotatingFileSink({ filePath, maxBytes: 1, maxFiles: 1 }).write("entry"),
    );

    expect(thrown).toBeInstanceOf(RotatingFileSinkError);
    expect(thrown).toMatchObject({ operation: "initialize", filePath });
    expect((thrown as RotatingFileSinkError).cause).toBeInstanceOf(Error);
  });

  // An over-long name is the one stat failure that is neither ENOENT nor a
  // permission problem on posix. Windows reports it as ENOENT, so the sink
  // correctly treats it as an absent file and there is nothing to assert.
  it.skipIf(windowsHost)("only treats a missing log file as an empty current size", async () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "a".repeat(300));

    const thrown = await captureAsyncError(() =>
      new RotatingFileSink({ filePath, maxBytes: 1, maxFiles: 1 }).write("entry"),
    );

    expect(thrown).toBeInstanceOf(RotatingFileSinkError);
    expect(thrown).toMatchObject({ operation: "read", filePath });
    expect((thrown as RotatingFileSinkError).cause).toMatchObject({ code: "ENAMETOOLONG" });
  });

  it("starts an absent log file at zero bytes", async () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    const sink = new RotatingFileSink({ filePath, maxBytes: 100, maxFiles: 1 });

    await sink.write("entry");

    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("entry");
  });

  it("keeps concurrent writes in order across rotations and prunes old backups", async () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    const sink = new RotatingFileSink({ filePath, maxBytes: 4, maxFiles: 2, throwOnError: true });

    await Promise.all(["aa", "bb", "cc", "dd", "ee", "ff", "gg"].map((chunk) => sink.write(chunk)));

    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("gg");
    expect(NodeFS.readFileSync(`${filePath}.1`, "utf8")).toBe("eeff");
    expect(NodeFS.readFileSync(`${filePath}.2`, "utf8")).toBe("ccdd");
    expect(NodeFS.existsSync(`${filePath}.3`)).toBe(false);
  });

  it("accepts a later write after an append failure", async () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    const sink = new RotatingFileSink({
      filePath,
      maxBytes: Number.MAX_SAFE_INTEGER,
      maxFiles: 1,
      throwOnError: true,
    });
    NodeFS.mkdirSync(filePath);
    await expect(sink.write("lost")).rejects.toMatchObject({ operation: "write" });
    NodeFS.rmdirSync(filePath);

    await sink.write("recovered");

    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("recovered");
  });

  it("preserves write failures", async () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    NodeFS.mkdirSync(filePath);
    const sink = new RotatingFileSink({
      filePath,
      maxBytes: Number.MAX_SAFE_INTEGER,
      maxFiles: 1,
      throwOnError: true,
    });

    const thrown = await captureAsyncError(() => sink.write("entry"));

    expect(thrown).toBeInstanceOf(RotatingFileSinkError);
    expect(thrown).toMatchObject({ operation: "write", filePath });
    expect((thrown as RotatingFileSinkError).cause).toMatchObject({ code: "EISDIR" });
  });

  it("preserves rotation failures without an artificial write wrapper", async () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    NodeFS.writeFileSync(filePath, "a");
    NodeFS.mkdirSync(`${filePath}.1`);
    const sink = new RotatingFileSink({
      filePath,
      maxBytes: 1,
      maxFiles: 1,
      throwOnError: true,
    });

    const thrown = await captureAsyncError(() => sink.write("b"));

    expect(thrown).toBeInstanceOf(RotatingFileSinkError);
    expect(thrown).toMatchObject({ operation: "rotate", filePath });
    expect((thrown as RotatingFileSinkError).cause).toBeInstanceOf(Error);
  });

  it("never reports a rotation failure after successfully appending a chunk", async () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    NodeFS.mkdirSync(`${filePath}.1`);
    const sink = new RotatingFileSink({
      filePath,
      maxBytes: 1,
      maxFiles: 1,
      throwOnError: true,
    });

    await sink.write("oversized");

    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("oversized");
    const thrown = await captureAsyncError(() => sink.write("next"));
    expect(thrown).toMatchObject({ operation: "rotate", filePath });
    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("oversized");
  });

  it("preserves backup pruning failures", async () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    const overflowBackup = `${filePath}.2`;
    NodeFS.mkdirSync(overflowBackup);
    NodeFS.writeFileSync(NodePath.join(overflowBackup, "entry"), "occupied");

    const thrown = await captureAsyncError(() =>
      new RotatingFileSink({
        filePath,
        maxBytes: 1,
        maxFiles: 1,
        throwOnError: true,
      }).write("entry"),
    );

    expect(thrown).toBeInstanceOf(RotatingFileSinkError);
    expect(thrown).toMatchObject({ operation: "prune", filePath });
    expect((thrown as RotatingFileSinkError).cause).toBeInstanceOf(Error);
  });
});
