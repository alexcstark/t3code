import { describe, expect, it } from "vite-plus/test";

import {
  projectGroupTitleNeedsUpdate,
  resolveSelectedProjectGroup,
} from "./ProjectSettingsPanel.logic";

function projectGroup(projectKey: string, memberKeys: ReadonlyArray<string>) {
  return {
    projectKey,
    memberProjects: memberKeys.map((physicalProjectKey) => ({ physicalProjectKey })),
  };
}

describe("projectGroupTitleNeedsUpdate", () => {
  it("updates divergent member titles even when the next title is the derived group label", () => {
    expect(
      projectGroupTitleNeedsUpdate(["local-title", "remote-title"], "Repository name", true),
    ).toBe(true);
  });

  it("skips an untouched blur when the derived label differs from member titles", () => {
    expect(projectGroupTitleNeedsUpdate(["repo-slug", "repo-slug"], "Repository Name", false)).toBe(
      false,
    );
  });

  it("skips an update when every member already has the next title", () => {
    expect(projectGroupTitleNeedsUpdate(["Shared name", "Shared name"], "Shared name", true)).toBe(
      false,
    );
  });
});

describe("resolveSelectedProjectGroup", () => {
  it("follows the selected members when grouping changes the logical key", () => {
    const nextGroup = projectGroup("repository-path", ["local:project", "remote:project"]);
    const otherGroup = projectGroup("other", ["other:project"]);

    expect(
      resolveSelectedProjectGroup([otherGroup, nextGroup], "repository", {
        key: "repository",
        memberKeys: ["local:project", "remote:project"],
      }),
    ).toBe(nextGroup);
  });
});
