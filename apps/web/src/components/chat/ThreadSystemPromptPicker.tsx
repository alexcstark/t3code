import {
  DEFAULT_SYSTEM_PROMPT_CONTENT,
  type EnvironmentId,
  type SystemPrompt,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function ThreadSystemPromptPicker({
  environmentId,
  prompts,
  selected,
  onChange,
  disabled,
}: {
  environmentId: EnvironmentId;
  prompts: readonly SystemPrompt[];
  selected: SystemPrompt | null;
  onChange?: (prompt: SystemPrompt | null) => void;
  disabled: boolean;
}) {
  const [viewing, setViewing] = useState(false);
  const options =
    selected && !prompts.some((prompt) => prompt.id === selected.id)
      ? [...prompts, selected]
      : prompts;
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 pt-2 text-xs text-muted-foreground">
      <span>System prompt</span>
      {onChange ? (
        <Select
          value={selected?.id ?? ""}
          disabled={disabled}
          onValueChange={(value) => {
            if (value === "") onChange(null);
            else {
              const prompt = options.find((entry) => entry.id === value);
              if (prompt) onChange(prompt);
            }
          }}
        >
          <SelectTrigger size="sm" aria-label="System prompt">
            <SelectValue>{selected?.name ?? "T3 default"}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem value="">T3 default</SelectItem>
            {options.map((prompt) => (
              <SelectItem key={prompt.id} value={prompt.id}>
                {prompt.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : (
        <span>{selected?.name ?? "T3 default"}</span>
      )}
      <Button size="xs" variant="ghost" onClick={() => setViewing(true)}>
        View
      </Button>
      {onChange ? (
        <Link
          to="/settings/general"
          search={{ machine: environmentId, project: undefined, checkout: undefined }}
          hash="system-prompts"
        >
          Manage prompts
        </Link>
      ) : null}
      <Dialog open={viewing} onOpenChange={setViewing}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{selected?.name ?? "T3 default"}</DialogTitle>
            <DialogDescription>
              {onChange
                ? "Instructions for this new thread."
                : "Instructions saved when this thread started."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <pre className="whitespace-pre-wrap break-words text-xs">
              {selected?.content ?? DEFAULT_SYSTEM_PROMPT_CONTENT}
            </pre>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
