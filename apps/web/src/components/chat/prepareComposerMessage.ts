import type { EnvironmentId } from "@t3tools/contracts";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";

import type {
  ComposerFileAttachment,
  ComposerImageAttachment,
  ComposerThreadTarget,
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
    if (input.usesAttachmentUploads && input.attachments.length > 0) {
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
      if (
        getUploadedAttachments({
          environmentId: input.environmentId,
          images: input.attachments,
        }) === null
      ) {
        throw new Error("Retry or remove failed uploads before sending.");
      }
    }
    const attachments = await Promise.all(
      input.attachments.map(async (attachment) => {
        if (input.usesAttachmentUploads) {
          const uploaded = getUploadedAttachments({
            environmentId: input.environmentId,
            images: [attachment],
          })?.[0];
          if (!uploaded)
            throw new Error(`Attachment '${attachment.name}' did not finish uploading.`);
          return uploaded;
        }
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
    );
    const fileBlockReason = input.readFileBlockReason();
    if (fileBlockReason !== null) throw new Error(fileBlockReason);
    return attachments;
  });
  return { message, attachments };
}
