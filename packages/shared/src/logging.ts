// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

export interface RotatingFileSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly throwOnError?: boolean;
}

export class RotatingFileSinkConfigurationError extends Schema.TaggedError<RotatingFileSinkConfigurationError>()(
  "RotatingFileSinkConfigurationError",
  {
    option: Schema.Literals(["maxBytes", "maxFiles"]),
    received: Schema.Number,
    minimum: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.option} must be >= ${this.minimum} (received ${this.received})`;
  }
}

export class RotatingFileSinkError extends Schema.TaggedError<RotatingFileSinkError>()(
  "RotatingFileSinkError",
  {
    operation: Schema.Literals(["initialize", "read", "write", "rotate", "prune"]),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} rotating log file ${this.filePath}`;
  }
}

const isRotatingFileSinkError = Schema.is(RotatingFileSinkError);

const isFileNotFoundError = (cause: unknown): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

export class RotatingFileSink {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly throwOnError: boolean;
  private currentSize = 0;
  private initialized = false;
  private pendingWrite = Promise.resolve();

  constructor(options: RotatingFileSinkOptions) {
    if (options.maxBytes < 1) {
      throw new RotatingFileSinkConfigurationError({
        option: "maxBytes",
        received: options.maxBytes,
        minimum: 1,
      });
    }
    if (options.maxFiles < 1) {
      throw new RotatingFileSinkConfigurationError({
        option: "maxFiles",
        received: options.maxFiles,
        minimum: 1,
      });
    }

    this.filePath = options.filePath;
    this.maxBytes = options.maxBytes;
    this.maxFiles = options.maxFiles;
    this.throwOnError = options.throwOnError ?? false;
  }

  /** Writes are serialized so rotation cannot overtake an earlier append. */
  write(chunk: string | Buffer): Promise<void> {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buffer.length === 0) return Promise.resolve();
    const write = this.pendingWrite.then(() => this.append(buffer));
    // A failed write is reported to its caller; a later write can recover.
    this.pendingWrite = write.catch(() => undefined);
    return write;
  }

  private async initialize(): Promise<void> {
    try {
      await NodeFS.promises.mkdir(NodePath.dirname(this.filePath), { recursive: true });
    } catch (cause) {
      throw new RotatingFileSinkError({ operation: "initialize", filePath: this.filePath, cause });
    }
    await this.pruneOverflowBackups();
    this.currentSize = await this.readCurrentSize();
    this.initialized = true;
  }

  private async append(buffer: Buffer): Promise<void> {
    if (!this.initialized) await this.initialize();
    try {
      if (this.currentSize > 0 && this.currentSize + buffer.length > this.maxBytes) {
        await this.rotate();
      }
      await NodeFS.promises.appendFile(this.filePath, buffer);
      this.currentSize += buffer.length;
    } catch (cause) {
      if (isRotatingFileSinkError(cause)) throw cause;
      if (this.throwOnError) {
        throw new RotatingFileSinkError({ operation: "write", filePath: this.filePath, cause });
      }
      this.currentSize = await this.readCurrentSize();
    }
  }

  private async moveIfPresent(source: string, target: string): Promise<void> {
    try {
      await NodeFS.promises.rename(source, target);
    } catch (cause) {
      if (!isFileNotFoundError(cause)) throw cause;
    }
  }

  private async rotate(): Promise<void> {
    try {
      await NodeFS.promises.rm(this.withSuffix(this.maxFiles), { force: true });
      for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
        await this.moveIfPresent(this.withSuffix(index), this.withSuffix(index + 1));
      }
      await this.moveIfPresent(this.filePath, this.withSuffix(1));
      this.currentSize = 0;
    } catch (cause) {
      if (this.throwOnError) {
        throw new RotatingFileSinkError({ operation: "rotate", filePath: this.filePath, cause });
      }
      this.currentSize = await this.readCurrentSize();
    }
  }

  private async pruneOverflowBackups(): Promise<void> {
    try {
      const dir = NodePath.dirname(this.filePath);
      const baseName = NodePath.basename(this.filePath);
      for (const entry of await NodeFS.promises.readdir(dir)) {
        if (!entry.startsWith(`${baseName}.`)) continue;
        const suffix = Number(entry.slice(baseName.length + 1));
        if (!Number.isInteger(suffix) || suffix <= this.maxFiles) continue;
        await NodeFS.promises.rm(NodePath.join(dir, entry), { force: true });
      }
    } catch (cause) {
      if (this.throwOnError) {
        throw new RotatingFileSinkError({ operation: "prune", filePath: this.filePath, cause });
      }
    }
  }

  private async readCurrentSize(): Promise<number> {
    try {
      return (await NodeFS.promises.stat(this.filePath)).size;
    } catch (cause) {
      if (isFileNotFoundError(cause)) return 0;
      throw new RotatingFileSinkError({ operation: "read", filePath: this.filePath, cause });
    }
  }

  private withSuffix(index: number): string {
    return `${this.filePath}.${index}`;
  }
}
