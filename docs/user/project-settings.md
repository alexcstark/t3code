# Project settings

Open **Settings → Projects** and select a project to change its preferences.

## Project icons

Choose an icon, emoji, or image from the project to make it easier to recognize. The choice applies
to every checkout in the project group and appears on connected clients. Choose **Automatic** to
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
