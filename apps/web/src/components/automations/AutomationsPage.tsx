import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { isElectron } from "../../env";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { useEnvironmentAutomations } from "../../state/automations";
import { useProjects, useThreadShells } from "../../state/entities";
import { ThreadAutomationsPanel } from "../chat/ThreadAutomationsPanel";
import { ThreadRowLeadingStatus } from "../ThreadStatusIndicators";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

interface AutomatedThread {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly threadId: ThreadId;
  /** Shown when the thread shell is not loaded, e.g. the thread was deleted. */
  readonly fallbackTitle: string;
}

/**
 * Long-running threads driven by a bound scheduled task, kept apart from the
 * sidebar thread list. Each card opens its thread to watch and talk to it, and
 * reuses the thread's own Automations panel for pause, run now, and edit.
 */
export function AutomationsPage() {
  useEscapeToGoBack();
  const environments = useEnvironmentAutomations();
  const threads = useThreadShells();
  const projects = useProjects();

  const automatedThreads = useMemo(() => {
    const byKey = new Map<string, AutomatedThread>();
    for (const environment of environments) {
      for (const task of environment.tasks ?? []) {
        if (task.threadId === null) continue;
        const key = `${environment.environmentId}:${task.threadId}`;
        if (byKey.has(key)) continue;
        byKey.set(key, {
          environmentId: environment.environmentId,
          environmentLabel: environment.label,
          threadId: task.threadId,
          fallbackTitle: task.title,
        });
      }
    }
    return [...byKey.values()];
  }, [environments]);
  const threadByKey = useMemo(
    () => new Map(threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread])),
    [threads],
  );
  const projectTitleByKey = useMemo(
    () =>
      new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project.title])),
    [projects],
  );
  const unavailable = environments.filter(
    (environment) => !environment.connected || environment.error,
  );
  const loading = environments.some(
    (environment) => environment.connected && !environment.error && environment.tasks === null,
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <WorkspaceBreadcrumb ariaLabel="Automations breadcrumb" className="min-w-0 py-2">
            <WorkspaceBreadcrumbItem current>
              <h1>Automations</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="readable" className="gap-4">
            {unavailable.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Not showing automations from {unavailable.map((env) => env.label).join(", ")} until{" "}
                {unavailable.length === 1 ? "it reconnects" : "they reconnect"}.
              </p>
            ) : null}

            {automatedThreads.length === 0 ? (
              loading ? null : (
                <Empty>
                  <EmptyHeader className="max-w-md">
                    <EmptyTitle>No automated threads</EmptyTitle>
                    <EmptyDescription>
                      Create a scheduled task that runs in an existing thread, and that thread moves
                      here from the sidebar. Manage tasks in{" "}
                      <Link to="/settings/scheduled-tasks" className="underline underline-offset-2">
                        Settings
                      </Link>
                      .
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )
            ) : (
              automatedThreads.map((automated) => {
                const thread = threadByKey.get(`${automated.environmentId}:${automated.threadId}`);
                const projectTitle = thread
                  ? projectTitleByKey.get(`${thread.environmentId}:${thread.projectId}`)
                  : undefined;
                return (
                  <article
                    key={`${automated.environmentId}:${automated.threadId}`}
                    className="overflow-hidden rounded-xl border border-border/65 bg-card"
                  >
                    <Link
                      to="/$environmentId/$threadId"
                      params={{
                        environmentId: automated.environmentId,
                        threadId: automated.threadId,
                      }}
                      className="flex min-w-0 items-center gap-2 px-4 py-3 hover:bg-accent/50"
                    >
                      {thread ? <ThreadRowLeadingStatus thread={thread} /> : null}
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {thread?.title ?? automated.fallbackTitle}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {[projectTitle, automated.environmentLabel]
                            .filter((part) => part !== undefined)
                            .join(" · ")}
                          {thread ? "" : " · thread unavailable"}
                        </span>
                      </div>
                    </Link>
                    <ThreadAutomationsPanel
                      environmentId={automated.environmentId}
                      threadId={automated.threadId}
                    />
                  </article>
                );
              })
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
