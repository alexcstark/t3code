# Project settings

Open **Settings → Projects**. The project and machine pickers start at **All projects** and
**All machines**.

Change the default model, workspace, automatic pull, agent browser access, or actions for projects that inherit those values.
Select an individual project to override a default. Reset its row to inherit again. Changing a
default preserves explicit project overrides. Workspace preferences in `t3.json` take precedence
over machine defaults when the project has no explicit workspace override.

Select a machine to limit edits to it. **All machines** writes defaults to connected machines;
offline machines keep their previous values. Mixed values are indicated when selected machines
or checkouts disagree. Browser access changes apply when an agent session next starts.

Project grouping has a client-wide default across machines, with individual checkout overrides.
Shared actions apply to inheriting projects; editing a project's actions creates an independent list.
Reset that list to use shared actions again. Existing project actions are preserved.

Project names, icons, removal, and importing actions from a checkout remain project-specific.
When there are several checkouts, the checkout picker selects which actions and grouping to edit.

## Project icons

Choose an icon, emoji, or image from the project to make it easier to recognize. The choice applies
to selected checkouts in the project group and appears on connected clients. Choose **Automatic** to
let T3 Code detect an icon again.

## Keep the default branch current

Enable **Automatically pull** to keep the default-branch checkout up to date with its configured
upstream.

The pull is skipped if the checkout is on another branch, has no upstream, or contains local work.
Pull failures do not prevent the server from starting.

## Defaults for new threads

Open **Settings** → **Projects**, select a project, and use **New threads** to set:

- **Model**: the provider and model used by new threads in the project.
- **Workspace**: whether new threads use the current checkout or a new worktree.
- **Location**: which connected environment (such as a remote machine) receives new threads when
  the project has checkouts on multiple environments.

The location preference is stored locally in the T3 Code client. **Default** uses the checkout you
opened or selected. Explicitly choosing a branch, worktree, or workspace in the composer overrides
the project location default.
