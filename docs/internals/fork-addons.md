# Fork addons

Fork-only product customizations live under `apps/web/src/addons/`. Each addon
owns its presentation code, styles, and focused tests. Upstream feature code
should remain unchanged unless the addon needs a small host hook.

The terminal shell is the first addon. Its stylesheet is imported separately
from the upstream `index.css`, and `ChatView` only supplies the root props and
runtime status values that the addon cannot discover on its own.

When updating from upstream:

1. Keep addon files in their own commits where practical.
2. Rebase or merge upstream before resolving addon host-hook conflicts.
3. If upstream changes the chat markup targeted by an addon stylesheet, update
   the addon and its tests together.
4. Do not copy addon styles back into shared stylesheets; that makes future
   upstream pulls needlessly conflict-prone.
