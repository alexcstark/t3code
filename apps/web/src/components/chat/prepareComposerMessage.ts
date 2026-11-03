import type { EnvironmentId } from "@t3tools/contracts";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";

import {
  composerDraftHasUserContent,
  useComposerDraftStore,
  type ComposerThreadDraftState,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  retryAttachmentUpload,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { readFileAsDataUrl } from "../../lib/imageCompression";
import type { ChatMessage } from "../../types";
import { cloneComposerImageForRetry } from "../ChatView.logic";

export function prepareComposerMessage(input: {
  readonly environmentId: EnvironmentId;
  readonly draftTarget: ComposerThreadTarget;
  readonly message: Omit<ChatMessage, "attachments">;
  readonly attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>;
  readonly usesAttachmentUploads: boolean;
  readonly readFileBlockReason: () => string | null;
}) {
  const optimisticAttachments = input.attachments.map((attachment) => ({
    type: attachment.type,
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    ...(attachment.type === "image"
      ? { previewUrl: attachment.previewUrl }
      : { downloadable: false }),
    ...(attachment.source ? { source: attachment.source } : {}),
  }));
  const message: ChatMessage = {
    ...input.message,
    ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
  };
  const attachments = settlePromise(async () => {
    if (input.usesAttachmentUploads) {
      for (const attachment of input.attachments) {
        const upload =
          readAttachmentUpload(attachment.id)?.status === "failed"
            ? retryAttachmentUpload
            : startAttachmentUpload;
        upload({
          environmentId: input.environmentId,
          image: attachment,
          draftTarget: input.draftTarget,
        });
      }
      await awaitAttachmentUploads(input.attachments.map((attachment) => attachment.id));
    }
    const uploaded = input.usesAttachmentUploads
      ? getUploadedAttachments({ environmentId: input.environmentId, images: input.attachments })
      : null;
    if (input.usesAttachmentUploads && uploaded === null) {
      throw new Error("Retry or remove failed uploads before sending.");
    }
    const attachments =
      uploaded ??
      (await Promise.all(
        input.attachments.map(async (attachment) => {
          if (attachment.type !== "image")
            throw new Error("This server does not support file attachments.");
          return {
            type: "image" as const,
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            dataUrl: await readFileAsDataUrl(attachment.file),
            ...(attachment.source ? { source: attachment.source } : {}),
          };
        }),
      ));
    const fileBlockReason = input.readFileBlockReason();
    if (fileBlockReason !== null) throw new Error(fileBlockReason);
    return attachments;
  });
  return { message, attachments };
}

export function restoreFailedComposerMessage(
  target: ComposerThreadTarget,
  snapshot: Pick<
    ComposerThreadDraftState,
    | "prompt"
    | "images"
    | "files"
    | "terminalContexts"
    | "previewAnnotations"
    | "reviewComments"
    | "threadContexts"
  >,
) {
  const store = useComposerDraftStore.getState();
  if (composerDraftHasUserContent(store.getComposerDraft(target))) return null;
  const images = snapshot.images.map(cloneComposerImageForRetry);
  store.setPrompt(target, snapshot.prompt);
  store.addImages(target, images);
  store.addFiles(target, snapshot.files);
  store.setTerminalContexts(target, snapshot.terminalContexts);
  store.setPreviewAnnotations(target, snapshot.previewAnnotations);
  store.setReviewComments(target, snapshot.reviewComments);
  store.setThreadContexts(target, snapshot.threadContexts);
  return images;
}
