import { Spinner } from "~/components/ui/spinner";
import { CircleAlertIcon, WifiOffIcon } from "lucide-react";
import { InlineButton } from "../ui/button";

import { threadSyncLabel, type ThreadSyncPhase } from "../../threadSync";
import { ComposerBanner } from "./ComposerBanner";

export function ComposerActivityRow({
  phase,
  onRetry,
}: {
  readonly phase: ThreadSyncPhase;
  readonly onRetry?: (() => void) | undefined;
}) {
  return (
    <ComposerBanner.Row>
      <ComposerBanner.Icon>
        {phase === "failed" ? (
          <CircleAlertIcon />
        ) : phase === "offline" ? (
          <WifiOffIcon />
        ) : (
          <Spinner />
        )}
      </ComposerBanner.Icon>
      <ComposerBanner.Content>
        <span
          className="shrink-0 whitespace-nowrap text-muted-foreground"
          data-composer-sync-status={phase}
          role="status"
        >
          {threadSyncLabel(phase)}
        </span>
      </ComposerBanner.Content>
      {(phase === "failed" || phase === "offline") && onRetry ? (
        <InlineButton onClick={onRetry}>Retry</InlineButton>
      ) : null}
    </ComposerBanner.Row>
  );
}
