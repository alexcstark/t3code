# Customize a project icon

T3 Code selects a project icon automatically. It checks `t3.json`, common favicon and app icon
paths, and icon links in project HTML files.

To choose a different icon:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Under **Appearance**, select **Choose a project file**.
4. Search for an image file and select it.

T3 Code supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.

## Defaults for new threads

Open **Settings** → **Projects**, select a project, and use **New threads** to set:

- **Model**: the provider and model used by new threads in the project.
- **Workspace**: whether new threads use the current checkout or a new worktree.
- **Location**: which connected environment (such as a remote machine) receives new threads when
  the project has checkouts on multiple environments.

The location preference is stored locally in the T3 Code client. **Default** uses the checkout you
opened or selected. Explicitly choosing a branch, worktree, or workspace in the composer overrides
the project location default.
