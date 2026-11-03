import { EnvironmentId, MessageId, ThreadId, type ChatAttachment } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { expect, it, vi } from "vite-plus/test";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import { prepareComposerMessage } from "./prepareComposerMessage";

const transport = vi.hoisted(() => ({
  upload: vi.fn<() => Promise<void>>(),
  uploaded: vi.fn<() => ChatAttachment[] | null>(),
}));
vi.mock("../../lib/attachmentUploadQueue", () => ({
  awaitAttachmentUploads: () => transport.upload(),
  getUploadedAttachments: () => transport.uploaded(),
  readAttachmentUpload: () => undefined,
  retryAttachmentUpload: vi.fn(),
  startAttachmentUpload: vi.fn(),
}));

function deferredResponse() {
  let resolve: (() => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const promise = new Promise<void>((resolveResponse, rejectResponse) => {
    resolve = resolveResponse;
    reject = rejectResponse;
  });
  if (!resolve || !reject) throw new Error("Promise executor did not initialize the response");
  return { promise, resolve, reject };
}

function setup() {
  const upload = deferredResponse();
  transport.upload.mockReset().mockReturnValue(upload.promise);
  transport.uploaded.mockReset().mockReturnValue([
    {
      type: "image",
      id: "uploaded-image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 1,
    },
  ]);
  const image: ComposerImageAttachment = {
    type: "image",
    id: "local-image",
    name: "image.png",
    mimeType: "image/png",
    sizeBytes: 1,
    file: new File(["x"], "image.png", { type: "image/png" }),
    previewUrl: "blob:local-preview",
  };
  const environmentId = EnvironmentId.make("environment-test");
  const input = {
    environmentId,
    draftTarget: { environmentId, threadId: ThreadId.make("thread-test") },
    message: {
      id: MessageId.make("message-test"),
      role: "user" as const,
      text: "Please check this image",
      runId: null,
      createdAt: "2026-11-03T00:00:00.000Z",
      updatedAt: "2026-11-03T00:00:00.000Z",
      streaming: false,
    },
    attachments: [image],
    usesAttachmentUploads: true,
    readFileBlockReason: (): string | null => null,
  };
  return { upload, image, input };
}

it("returns the conversation message before its attachments finish uploading", async () => {
  const { input, upload } = setup();
  const prepared = prepareComposerMessage(input);
  expect(prepared.message).toEqual({
    ...input.message,
    attachments: [
      {
        id: "local-image",
        type: "image",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 1,
        previewUrl: "blob:local-preview",
      },
    ],
  });
  upload.resolve();
  const result = await prepared.attachments;
  expect(result._tag).toBe("Success");
  if (result._tag !== "Success") throw squashAtomCommandFailure(result);
  expect(result.value[0]?.id).toBe("uploaded-image");
  expect(prepared.message.attachments?.[0]?.id).toBe("local-image");
});

it.each(["failed", "rejected", "capability changed"])(
  "reports a %s upload for draft recovery",
  async (failure) => {
    const { input, upload } = setup();
    let blockReason: string | null = null;
    const prepared = prepareComposerMessage({ ...input, readFileBlockReason: () => blockReason });
    if (failure === "failed") transport.uploaded.mockReturnValue(null);
    if (failure === "capability changed") blockReason = "This file is too large for this server.";
    if (failure === "rejected") upload.reject(new Error("Connection lost"));
    else upload.resolve();
    const result = await prepared.attachments;
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("The upload unexpectedly succeeded");
    expect(squashAtomCommandFailure(result)).toEqual(
      new Error(
        failure === "failed"
          ? "Retry or remove failed uploads before sending."
          : failure === "rejected"
            ? "Connection lost"
            : (blockReason ?? ""),
      ),
    );
  },
);

it("prepares legacy image data without delaying the conversation message", async () => {
  const { input } = setup();
  const prepared = prepareComposerMessage({ ...input, usesAttachmentUploads: false });
  expect(prepared.message.text).toBe(input.message.text);
  const result = await prepared.attachments;
  if (result._tag !== "Success") throw squashAtomCommandFailure(result);
  expect(result.value).toEqual([
    {
      type: "image",
      id: "local-image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 1,
      dataUrl: "data:image/png;base64,eA==",
    },
  ]);
});

it("shows local file metadata and sends the uploaded file identity", async () => {
  const { input, upload } = setup();
  const file: ComposerFileAttachment = {
    type: "file",
    id: "local-file",
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 1,
    file: new File(["x"], "notes.txt", { type: "text/plain" }),
  };
  transport.uploaded.mockReturnValue([
    { type: "file", id: "uploaded-file", name: file.name, mimeType: file.mimeType, sizeBytes: 1 },
  ]);
  const prepared = prepareComposerMessage({ ...input, attachments: [file] });
  expect(prepared.message.attachments).toEqual([
    {
      type: "file",
      id: "local-file",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      downloadable: false,
    },
  ]);
  upload.resolve();
  const result = await prepared.attachments;
  if (result._tag !== "Success") throw squashAtomCommandFailure(result);
  expect(result.value[0]?.id).toBe("uploaded-file");
});
