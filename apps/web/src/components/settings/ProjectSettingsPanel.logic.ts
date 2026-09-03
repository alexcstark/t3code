export interface ProjectGroupSelection {
  readonly key: string;
  readonly memberKeys: ReadonlyArray<string>;
}

interface ProjectGroupIdentity {
  readonly projectKey: string;
  readonly memberProjects: ReadonlyArray<{
    readonly physicalProjectKey: string;
  }>;
}

export function resolveSelectedProjectGroup<T extends ProjectGroupIdentity>(
  groups: ReadonlyArray<T>,
  selectedProjectKey: string | null,
  previousSelection: ProjectGroupSelection | null,
): T | null {
  const selected = groups.find((group) => group.projectKey === selectedProjectKey);
  if (selected) return selected;

  if (previousSelection?.key === selectedProjectKey) {
    const previousMemberKeys = new Set(previousSelection.memberKeys);
    const successor = groups.find((group) =>
      group.memberProjects.some((member) => previousMemberKeys.has(member.physicalProjectKey)),
    );
    if (successor) return successor;
  }

  return groups[0] ?? null;
}

export function projectGroupTitleNeedsUpdate(
  memberTitles: ReadonlyArray<string>,
  nextTitle: string,
  wasEdited: boolean,
): boolean {
  return wasEdited && memberTitles.some((title) => title !== nextTitle);
}
