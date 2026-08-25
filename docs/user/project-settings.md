# Customize a project icon

T3 Code selects a project icon automatically. It checks `t3.json`, common favicon and app icon
paths, and icon links in project HTML files. If it does not find an image, it chooses a built-in
emoji from the project name.

To choose a different icon or emoji:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Next to **Project icon**, select **Choose icon**.
4. Search the full Lucide icon set and choose a color, or switch to **Emoji** and choose or paste
   an emoji.

To use an image from the project instead, select **Choose file**, search for an image, and select
it.

T3 Code supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.

## Keep the default branch current

Turn on **Automatically pull** in a project's settings to keep its default-branch checkout current.
T3 Code checks in the background and when the server starts. It uses the branch's configured
upstream and only performs a fast-forward pull when the checkout has no working-tree changes,
untracked files, or local commits.

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
