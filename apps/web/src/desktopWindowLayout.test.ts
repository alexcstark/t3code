import { describe, expect, it } from "vite-plus/test";

import { createWindowThreadFilter, type DesktopWindowLayoutView } from "./desktopWindowLayout";

const projectKeyByProjectRef = new Map([
  ["env:alpha", "alpha"],
  ["env:beta", "beta"],
]);

function visibleIn(
  view: DesktopWindowLayoutView,
  threads: ReadonlyArray<readonly [threadKey: string, projectRef: string]>,
  scopedProjectKeys: ReadonlySet<string> | null = null,
) {
  const filter = createWindowThreadFilter({ view, projectKeyByProjectRef, scopedProjectKeys });
  return filter === null
    ? null
    : threads.filter(([key, ref]) => filter(key, ref)).map(([key]) => key);
}

const threads = [
  ["env:a1", "env:alpha"],
  ["env:a2", "env:alpha"],
  ["env:b1", "env:beta"],
] as const;

describe("createWindowThreadFilter", () => {
  it("leaves a lone window showing everything", () => {
    expect(
      visibleIn(
        {
          windowId: "home",
          layout: { windows: [{ id: "home", projectScopeKey: null }], assignments: {} },
        },
        threads,
      ),
    ).toBeNull();
  });

  it("opens a second window on the same project empty, then shows what moves in", () => {
    const windows = [
      { id: "home", projectScopeKey: "alpha" },
      { id: "second", projectScopeKey: "alpha" },
    ];
    const alphaRefs = new Set(["env:alpha"]);
    expect(
      visibleIn({ windowId: "second", layout: { windows, assignments: {} } }, threads, alphaRefs),
    ).toEqual([]);

    const layout = { windows, assignments: { "env:a2": "second" } };
    expect(visibleIn({ windowId: "second", layout }, threads, alphaRefs)).toEqual(["env:a2"]);
    expect(visibleIn({ windowId: "home", layout }, threads, alphaRefs)).toEqual(["env:a1"]);
  });

  it("gives a project window its project's threads and leaves the rest home", () => {
    const layout = {
      windows: [
        { id: "home", projectScopeKey: null },
        { id: "beta", projectScopeKey: "beta" },
      ],
      assignments: {},
    };
    expect(visibleIn({ windowId: "home", layout }, threads)).toEqual(["env:a1", "env:a2"]);
    expect(visibleIn({ windowId: "beta", layout }, threads, new Set(["env:beta"]))).toEqual([
      "env:b1",
    ]);
  });

  it("shows a moved thread even outside the window's project scope", () => {
    const layout = {
      windows: [
        { id: "home", projectScopeKey: null },
        { id: "second", projectScopeKey: "alpha" },
      ],
      assignments: { "env:b1": "second" },
    };
    expect(visibleIn({ windowId: "second", layout }, threads, new Set(["env:alpha"]))).toEqual([
      "env:a1",
      "env:a2",
      "env:b1",
    ]);
  });

  it("falls back to every thread when the layout does not know this window", () => {
    const layout = {
      windows: [
        { id: "home", projectScopeKey: null },
        { id: "second", projectScopeKey: null },
      ],
      assignments: {},
    };
    expect(visibleIn({ windowId: "stale", layout }, threads)).toBeNull();
  });
});
