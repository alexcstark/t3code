import type {
  ContextMenuItem,
  DesktopWindowLayout,
  DesktopWindowMoveTarget,
} from "@t3tools/contracts";
import { create } from "zustand";

export interface DesktopWindowLayoutView {
  readonly windowId: string;
  readonly layout: DesktopWindowLayout;
}

// Which window shows a thread: the window it was moved into, else the first
// window scoped to its project, else the first unscoped window, else home.
// Every window resolves the same layout, so each thread shows in exactly one.
function resolveThreadWindowId(
  layout: DesktopWindowLayout,
  threadKey: string,
  projectKey: string | null,
): string | null {
  const assigned = layout.assignments[threadKey];
  if (assigned !== undefined && layout.windows.some((window) => window.id === assigned)) {
    return assigned;
  }
  const owner =
    (projectKey === null
      ? undefined
      : layout.windows.find((window) => window.projectScopeKey === projectKey)) ??
    layout.windows.find((window) => window.projectScopeKey === null) ??
    layout.windows[0];
  return owner?.id ?? null;
}

/**
 * Filters threads down to the ones this window shows, or null when the window
 * shows every thread its project scope allows (one window, the web app, or a
 * layout that does not know this window). Moved threads ignore the scope.
 */
export function createWindowThreadFilter(input: {
  readonly view: DesktopWindowLayoutView | null;
  readonly projectKeyByProjectRef: ReadonlyMap<string, string>;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
}): ((threadKey: string, projectRefKey: string) => boolean) | null {
  const { view, projectKeyByProjectRef, scopedProjectKeys } = input;
  if (view === null || view.layout.windows.length < 2) return null;
  const { layout, windowId } = view;
  if (!layout.windows.some((window) => window.id === windowId)) return null;
  return (threadKey, projectRefKey) =>
    resolveThreadWindowId(layout, threadKey, projectKeyByProjectRef.get(projectRefKey) ?? null) ===
      windowId &&
    (scopedProjectKeys === null ||
      scopedProjectKeys.has(projectRefKey) ||
      layout.assignments[threadKey] === windowId);
}

export type MoveToWindowMenuId = "move-to-window" | `move-to-window:${string}`;
const NEW_WINDOW_MENU_ID = "move-to-window:new";

// Lists the other open windows plus a new one. Null where windows cannot move threads.
export function buildMoveToWindowMenuItem(
  view: DesktopWindowLayoutView | null,
  count?: number,
): ContextMenuItem<MoveToWindowMenuId> | null {
  if (
    view === null ||
    typeof window === "undefined" ||
    !window.desktopBridge?.moveThreadsToWindow
  ) {
    return null;
  }
  const others = view.layout.windows.flatMap((entry, index) =>
    entry.id === view.windowId
      ? []
      : [
          {
            id: `move-to-window:${entry.id}` as const,
            label: index === 0 ? "Main window" : `Window ${index + 1}`,
          },
        ],
  );
  return {
    id: "move-to-window",
    label: count === undefined ? "Move to window" : `Move to window (${count})`,
    children: [
      ...others,
      { id: NEW_WINDOW_MENU_ID, label: "New window", separatorBefore: others.length > 0 },
    ],
  };
}

// Places the move item just above the Copy group.
export function withMoveToWindowItem<T extends string>(
  items: ReadonlyArray<ContextMenuItem<T>>,
  moveItem: ContextMenuItem<MoveToWindowMenuId> | null,
): ReadonlyArray<ContextMenuItem<T | MoveToWindowMenuId>> {
  if (moveItem === null) return items;
  const copyIndex = items.findIndex((item) => item.id === "copy");
  const insertAt = copyIndex === -1 ? items.length : copyIndex;
  return [...items.slice(0, insertAt), moveItem, ...items.slice(insertAt)];
}

export function isMoveToWindowMenuId(id: string): id is MoveToWindowMenuId {
  return id.startsWith("move-to-window");
}

export function parseMoveToWindowMenuId(id: MoveToWindowMenuId): DesktopWindowMoveTarget | null {
  if (id === NEW_WINDOW_MENU_ID) return "new-window";
  return id.startsWith("move-to-window:") ? { windowId: id.slice("move-to-window:".length) } : null;
}

export function moveThreadsToWindow(
  threadKeys: readonly string[],
  target: DesktopWindowMoveTarget,
): Promise<boolean> {
  return (
    window.desktopBridge?.moveThreadsToWindow?.({ threadKeys, target }) ?? Promise.resolve(false)
  );
}

export function readDesktopWindowLayout(): DesktopWindowLayoutView | null {
  if (typeof window === "undefined") return null;
  try {
    return window.desktopBridge?.getWindowLayout?.() ?? null;
  } catch {
    return null;
  }
}

export const useDesktopWindowLayoutStore = create<{ view: DesktopWindowLayoutView | null }>(() => ({
  view: readDesktopWindowLayout(),
}));

if (typeof window !== "undefined") {
  window.desktopBridge?.onWindowLayout?.((layout) => {
    useDesktopWindowLayoutStore.setState(({ view }) =>
      view === null ? { view } : { view: { windowId: view.windowId, layout } },
    );
  });
}
