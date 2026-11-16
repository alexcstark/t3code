import { cn } from "~/lib/utils";

export function ChatPromptMarker({ className }: { readonly className: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute select-none text-sm leading-relaxed text-chat-prompt-marker",
        className,
      )}
    >
      {">"}
    </span>
  );
}
