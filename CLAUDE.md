# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Click Adventure is a **Foundry VTT (v14) module** — a point-and-click adventure navigation system. Plain ESM JavaScript, no bundler, no build step, no package.json. `module.json` points directly at `scripts/index.js` and the raw CSS files; Foundry loads them as-is.

## Dev workflow

- No build/lint/test tooling exists in this repo. There is nothing to `npm install`, compile, or run outside Foundry itself.
- CSS is used directly by Foundry — do not try to compile it, and there's no need to re-read it after editing to "build" it.
- To verify a change, it must be exercised inside a running Foundry VTT world with this module enabled (reload the world / refresh the client to pick up script changes).
- Versioning: bump `version` in `module.json` and add a matching entry at the top of `CHANGELOG.md` (newest first, `## [Changed]` / `## [Fixed]` / `## [Added]` sections) when cutting a release. Recent history shows this happens on nearly every commit — treat it as part of finishing a change, not a separate release step.

## Architecture

### Entry point and module structure

- `scripts/index.js` re-exports every class/module and then imports `click-adventure.js` last (it wires up Foundry's `init`/`ready` hooks and depends on everything above it being defined). `module.json` only references `index.js` — new files must be re-exported from here to be reachable.
- `scripts/constants.js` defines `MODULE_ID` — always import this rather than hardcoding the `"click-adventure"` string literal.
- `scripts/click-adventure.js` is the actual init/ready hook logic: registers the world settings, builds `globalThis.ClickAdventure` (the public console/macro API — `ClickAdventure.Manager()`, `.Groups()`, `.HUD()`), and maintains `_graphSceneIds`, a cache of every scene id belonging to a graph node (rebuilt from the graph setting; used to decide HUD visibility independent of a per-scene flag).

### Data model

- The entire adventure graph is persisted as a **world-scoped Foundry Setting** backed by a `DataModel`, not a database or files.
- `AdventureCollectionDataModel` (setting `click-adventure.graphs`) is the current shape: a list of named, independent graphs plus `activeGraphId`. Each entry in `graphs` is `{ id, name, startNodeId, nodes: [], links: [] }` — this is effectively the old single-graph shape (`AdventureDataModel`, setting `click-adventure.graph`) nested per group. `AdventureDataModel` is kept only for schema/back-compat, not for new code.
- Node shape: `{ id, label, images: [{id,src,label}], activeImageIndex, x, y, sceneId, linkedScenes?, ... }`. Prefer `getNodeActiveImage(node)` (node-utils.js) over reading `images`/`imageSrc` directly — it handles both the multi-image schema and the legacy single-`imageSrc` field.
- Link shape: `{ sourceId, sourceAnchor, targetId, targetAnchor, passages: [...] }` (plus legacy flat `direction`/state fields on older data). A link may hold multiple named passages with independent direction/state. Use `isMultiPassage(link)` and `getEffectiveDirection(link)` (node-utils.js) rather than reading `passages`/`direction` directly — they cover the legacy fallback.
- Each graph node maps 1:1 to a Foundry Scene (per-node `sceneId`); navigation swaps a **managed background tile's texture**, it does not change/activate the Foundry scene itself for the traveling player's own view logic (GM activation is separate). Read/write graph data through `getGraphData()` / `saveGraphData()` (node-utils.js) rather than touching the setting directly.

### UI layer (ApplicationV2)

Every window (`ManagerApp`, `GroupManagerApp`, `NodeConfigApp`, `NavHudApp`, `LinkEditorApp`, `InstructionsApp`, `HudStyleApp`, `AdventureIOApp`, `SettingsApp`) extends `HandlebarsApplicationMixin(ApplicationV2)` and pairs with an `.hbs` template of the same name in `templates/` and a `.css` file in `styles/` (registered individually in `module.json`, not bundled).

`ManagerApp` (`manager-app.js`) is the largest surface and is deliberately kept as a thin shell — ApplicationV2 lifecycle and event wiring only. Domain logic is split into sibling modules it delegates to:
- `manager-graph.js` — SVG link rendering, Bézier curve geometry.
- `manager-interaction.js` — node dragging, link drawing, canvas pan/zoom.
- `manager-players.js` — occupant display, teleport, navigation approval requests.
- `manager-scene-ops.js` — node creation, Foundry folder import, scene sync, reset.

When extending manager behavior, add to the relevant sibling module rather than growing `manager-app.js` directly.

### Realtime sync

`AdventureSocketManager` (`socket-manager.js`) is the only realtime channel — raw `game.socket` on namespace `module.click-adventure` (no socketlib dependency), dispatching on a `{ type, payload }` envelope. Known message types: `VIEW_SCENE_FOR_USER` (players can't call `scene.activate()`, so a player asks to have their own view changed and the target client applies it locally) and `PLAYER_MOVED` (lets the GM's open Manager patch occupant badges without a full re-render). socket.io does not echo a message back to its own emitter, so emitting code must apply its own local effect before broadcasting.

### Autolock

`autolock-utils.js` centralizes the player-lock feature (`shouldLockOnArrival`, `isUserLocked`, `lockUser`, `unlockUser`, `lockAllUsers`, `restoreLockedUsers`) — lock state must survive world pause/unpause, so any new call site that arrives a player at a node should go through `shouldLockOnArrival` rather than re-deriving the inherit/open/locked precedence (global setting vs. per-node override) inline.
