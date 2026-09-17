/**
 * Module entry point for Click Adventure.
 *
 * Registers the `click-adventure.graph` world setting backed by AdventureDataModel
 * and exposes the public API on `globalThis.ClickAdventure` during the `init` hook.
 *
 * Usage from the Foundry console:
 *   ClickAdventure.Manager()
 */

import { MODULE_ID } from "./constants.js";
import { AdventureDataModel } from "./adventure-data-model.js";
import { AdventureCollectionDataModel } from "./adventure-collection-model.js";
import { ManagerApp } from "./manager-app.js";
import { NavHudApp } from "./nav-hud-app.js";
import { GroupManagerApp } from "./group-manager-app.js";
import { AdventureSocketManager } from "./socket-manager.js";
import { getGraphData } from "./node-utils.js";
import { HudStyleApp } from "./hud-style-app.js";
import { AdventureIOApp } from "./adventure-io-app.js";
import { lockAllUsers, restoreLockedUsers } from "./autolock-utils.js";

/**
 * O(1) lookup set of sceneIds belonging to graph nodes.
 * Populated in the ready hook and rebuilt whenever the graph setting changes.
 * @type {Set<string>}
 */
let _graphSceneIds = new Set();

/**
 * Rebuilds _graphSceneIds from the current graph setting.
 * Must only be called after settings are available (ready hook or later).
 */
function _buildSceneIdCache() {
  const { nodes } = getGraphData();
  const primary = nodes.map(n => n.sceneId);
  const linked = nodes.flatMap(n => (n.linkedScenes ?? []).map(ls => ls.sceneId));
  _graphSceneIds = new Set([...primary, ...linked].filter(Boolean));
}

/**
 * Returns true if the given sceneId belongs to any node in the current graph.
 * Used to decide whether to show the HUD regardless of the scene flag.
 * @param {string|null} sceneId
 * @returns {boolean}
 */
function _isGraphScene(sceneId) {
  if (!sceneId) return false;
  return _graphSceneIds.has(sceneId);
}

/**
 * Show or hide the NavHUD based on the scene currently in view.
 * Uses canvas.scene (the viewed scene) rather than game.scenes.active so that
 * "View Scene" in the scene manager also triggers the HUD correctly.
 * Triggered by the canvasReady hook, which fires on every canvas load/switch.
 */
Hooks.on("canvasReady", () => {
  const scene = canvas.scene;
  const byFlag = scene?.flags?.[MODULE_ID]?.isAdventureScene === true;
  const byGraph = _isGraphScene(scene?.id);

  const hudVisibility = game.settings.get(MODULE_ID,"hudVisibility");
  const canSeeHud = game.user.isGM || hudVisibility === "all";

  if ((byFlag || byGraph) && canSeeHud) {
    ClickAdventure.HUD();
  } else {
    if (globalThis.ClickAdventure._hud?.rendered) {
      globalThis.ClickAdventure._hud.close();
    }
  }
});

/**
 * Re-evaluate HUD visibility whenever the graph setting changes.
 * Covers the case where scenes are created/synced and the current canvas
 * view is already a graph scene (canvasReady won't fire again).
 */
Hooks.on("updateSetting", (setting) => {
  if (setting.key !== `${MODULE_ID}.graphs`) return;
  _buildSceneIdCache();
  const scene = canvas?.scene;
  if (!scene) return;

  const hudVisibility = game.settings.get(MODULE_ID, "hudVisibility");
  const canSeeHud = game.user.isGM || hudVisibility === "all";

  const belongs = _graphSceneIds.has(scene.id);

  if (belongs && canSeeHud && !globalThis.ClickAdventure._hud?.rendered) {
    ClickAdventure.HUD();
  } else if (globalThis.ClickAdventure._hud?.rendered) {
    globalThis.ClickAdventure._hud.render({ force: true });
  }
});

/**
 * Immediately apply hudVisibility changes without requiring a canvas reload.
 * Closes non-GM HUDs when the GM switches to "gm-only", and re-opens them
 * when switching back to "all" if the current scene qualifies.
 */
Hooks.on("updateSetting", (setting) => {
  if (setting.key !== "click-adventure.hudVisibility") return;

  const hudVisibility = game.settings.get(MODULE_ID,"hudVisibility");
  const canSeeHud = game.user.isGM || hudVisibility === "all";

  if (!canSeeHud && globalThis.ClickAdventure._hud?.rendered) {
    globalThis.ClickAdventure._hud.close();
  } else if (canSeeHud && !globalThis.ClickAdventure._hud?.rendered) {
    const scene = canvas?.scene;
    if (!scene) return;
    const byFlag = scene?.flags?.[MODULE_ID]?.isAdventureScene === true;
    const byGraph = _isGraphScene(scene?.id);
    if (byFlag || byGraph) ClickAdventure.HUD();
  }
});

Hooks.on("updateSetting", (setting) => {
  if (setting.key !== "click-adventure.orbStyle") return;
  if (globalThis.ClickAdventure._hud?.rendered) {
    globalThis.ClickAdventure._hud.render({ force: true });
  }
});

/**
 * Refresh the HUD when the GM toggles destination previews so players gain or
 * lose the eye icon immediately, without reopening the canvas.
 */
Hooks.on("updateSetting", (setting) => {
  if (setting.key !== `${MODULE_ID}.playerDestinationPreview`) return;
  if (globalThis.ClickAdventure._hud?.rendered) {
    globalThis.ClickAdventure._hud.render({ force: true });
  }
});

/**
 * Re-render the HUD players panel when a user's flags change (e.g. navigation)
 * or when a user connects/disconnects.
 * Triggered by the native Foundry updateUser and userConnected hooks.
 */
Hooks.on("updateUser", () => globalThis.ClickAdventure?._hud?.render());
Hooks.on("userConnected", () => globalThis.ClickAdventure?._hud?.render());

/**
 * When the GM pauses the game: snapshot current lock state, then lock all players.
 * When the GM unpauses: restore the pre-pause lock state exactly.
 * Guard: only the GM can write world-scope settings.
 *
 * Triggered by the native Foundry pauseGame hook (v13/v14 compatible).
 * @param {boolean} paused
 */
Hooks.on("pauseGame", async (paused) => {
  if (!game.user.isGM) return;

  if (paused) {
    // Save current lockedUsers state before locking everyone
    const snapshot = game.settings.get(MODULE_ID,"lockedUsers") ?? [];
    await game.settings.set(MODULE_ID,"_pauseSnapshot", [...snapshot]);
    await lockAllUsers();
  } else {
    // Restore pre-pause lock state
    const snapshot = game.settings.get(MODULE_ID,"_pauseSnapshot") ?? [];
    await restoreLockedUsers(snapshot);
    // Clear the snapshot — it's no longer needed
    await game.settings.set(MODULE_ID,"_pauseSnapshot", []);
  }
});

/**
 * Restores the correct scene view based on the user's saved node position.
 * Runs for every user (GM and players alike) — each gets their own independent flag.
 * A user with no position yet (currentNodeId flag unset) is left alone — the module
 * never auto-places anyone; positioning happens only via explicit GM teleport (see
 * manager-players.js) or the "Activate group" action.
 * Only calls scene.view() when the currently viewed canvas scene differs from the
 * node's scene, avoiding a redundant reload when the user is already in the right place.
 */
Hooks.on("ready", async () => {
  _buildSceneIdCache();

  // Clear stale pause snapshot if the world reloaded without a proper unpause.
  // Prevents an old snapshot from being applied when someone unpauses in a new session.
  if (!game.paused && game.user.isGM) {
    await game.settings.set(MODULE_ID, "_pauseSnapshot", []);
  }

  const { nodes } = getGraphData();

  // Resolve the node the user is currently at, if any
  const currentNodeId = game.user.getFlag(MODULE_ID,"currentNodeId");
  if (!currentNodeId) return;

  const node = nodes.find(n => n.id === currentNodeId);
  if (!node?.sceneId) return;

  // Only switch view if the canvas is not already showing the correct scene.
  // This avoids a redundant scene.view() call when the user happens to reload
  // while already on their node's scene.
  if (canvas?.scene?.id === node.sceneId) return;

  // Never hijack a scene the GM/world has active that isn't part of this
  // adventure's graph — the module only restores position within its own
  // scenes, it never overrides a scene chosen on purpose.
  if (canvas?.scene && !_isGraphScene(canvas.scene.id)) return;

  const scene = game.scenes.get(node.sceneId);
  if (!scene) return;

  await scene.view();
});

Hooks.on("init", () => {
  Handlebars.registerHelper("eq", (a, b) => a === b);

  // Returns a Unicode glyph for a passage's direction axis (both/forward/backward).
  Handlebars.registerHelper("caDirectionAxisIcon", dirAxis => {
    const icons = { both: "⟷", forward: "→", backward: "←" };
    return icons[dirAxis] ?? "?";
  });

  // Returns a Unicode glyph for a passage's state axis (open/blocked/custom).
  // "secret" has no glyph here — the template renders an actual fa-mask icon for it instead.
  Handlebars.registerHelper("caStateAxisIcon", stateAxis => {
    const icons = { open: "O", blocked: "⊘", custom: "C" };
    return icons[stateAxis] ?? "?";
  });

  // Returns a Unicode/emoji icon for a key condition's type, used in the Passage Editor's
  // custom-state key chips.
  Handlebars.registerHelper("caKeyTypeIcon", type => {
    const icons = { item: "🎒", actor: "👤", macro: "⚡", scene: "🗺️" };
    return icons[type] ?? "?";
  });

  // Legacy single-graph setting — kept registered so existing data is never orphaned.
  // The ready hook migrates it into `graphs` on first load if needed.
  game.settings.register(MODULE_ID, "graph", {
    name: "Adventure Graph (legacy)",
    scope: "world",
    config: false,
    type: AdventureDataModel,
    default: { sceneId: "", startNodeId: "", nodes: [], links: [] }
  });

  // Multi-graph collection — the single source of truth from this version onwards.
  game.settings.register(MODULE_ID, "graphs", {
    name: "Adventure Graphs",
    scope: "world",
    config: false,
    type: AdventureCollectionDataModel,
    default: { activeGraphId: "", graphs: [] }
  });

  game.settings.register(MODULE_ID,"navigationMode", {
    name: "Navigation Mode",
    hint: "Open: players navigate freely. Gated: players must request GM approval.",
    scope: "world",
    config: false,
    type: String,
    default: "open",
    choices: { open: "Open Navigation", gated: "Gated Navigation" }
  });

  game.settings.register(MODULE_ID,"managerPan", {
    name: "Manager Pan Position",
    scope: "client",
    config: false,
    type: Object,
    default: { x: 0, y: 0 }
  });

  game.settings.register(MODULE_ID,"transitionType", {
    name: "Scene Transition Type",
    scope: "world",
    config: false,
    type: String,
    default: "null"
  });

  game.settings.register(MODULE_ID,"gmNavigationMode", {
    name: "GM Navigation Mode",
    scope: "world",
    config: false,
    type: String,
    default: "solo",
    choices: { solo: "Solo", guide: "Guide" }
  });

  game.settings.register(MODULE_ID,"guideModeAction", {
    name: "Guide Mode Action",
    hint: "View: sends each player to the scene individually. Activate: activates the scene globally (Foundry handles view for all connected users).",
    scope: "world",
    config: false,
    type: String,
    default: "view",
    choices: { view: "View (per-player)", activate: "Activate (global)" }
  });

  game.settings.register(MODULE_ID,"hudVisibility", {
    name: "HUD Visibility",
    hint: "Controls who sees the navigation HUD.",
    scope: "world",
    config: false,
    type: String,
    default: "all",
    choices: { all: "All players", "gm-only": "GM only" }
  });

  game.settings.register(MODULE_ID, "showPlayerWhisper", {
    name: "Show Player Locations",
    hint: "Allows players to see other connected players and preview the node image of where they are.",
    scope: "world",
    config: false,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "playerDestinationPreview", {
    name: "Player Destination Preview",
    hint: "Allows players to hover the eye icon on a destination to preview its room image before entering. The GM always sees previews.",
    scope: "world",
    config: false,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "journalAutoOpen", {
    name: "Journal Auto-Open",
    hint: "Automatically opens a node's journal page when its trigger condition (view/activate) is met. Disable during testing and setup, or once the adventure is well known.",
    scope: "world",
    config: false,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID,"orbStyle", {
    name: "HUD Button Style",
    hint: "Visual appearance of the navigation HUD button. Configured by the GM; applies to all players.",
    scope: "world",
    config: false,
    type: Object,
    default: { type: "orb", size: 1, color: "#d4a017", orbImage: "" }
  });

  game.settings.register(MODULE_ID,"defaultTokenPositions", {
    name: "Default Token Positions",
    hint: "Stores per-user default token spawn coordinates. Managed via the Settings panel in the Manager.",
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register(MODULE_ID,"useDefaultTokenPositions", {
    name: "Use Default Token Positions",
    hint: "When enabled, teleported tokens spawn at the captured positions instead of scene center.",
    scope: "world",
    config: false,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID,"autolockDefault", {
    scope: "world",
    config: false,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID,"lockedUsers", {
    scope: "world",
    config: false,
    type: Array,
    default: []
    // Stored as: [{ userId: string, nodeId: string }, ...]
  });

  game.settings.register(MODULE_ID,"_pauseSnapshot", {
    scope: "world",
    config: false,
    type: Array,
    default: []
    // Stores the lockedUsers array as it was immediately before a pause.
    // Restored verbatim on unpause to preserve manual locks set before pausing.
  });

  game.settings.registerMenu(MODULE_ID, "orbStyleMenu", {
    name: "HUD Button Style",
    label: "Customize HUD Button Style…",
    hint: "Configure the visual appearance of the navigation HUD button. Only the GM can change this; changes apply to all players.",
    icon: "fa-regular fa-circle",
    type: HudStyleApp,
    restricted: true
  });

  game.settings.registerMenu(MODULE_ID, "adventureIOMenu", {
    name: "Export / Import Adventure",
    label: "Export / Import…",
    hint: "Export adventure groups to a JSON file, or import groups from a previously exported file into this world.",
    icon: "fa-solid fa-file-export",
    type: AdventureIOApp,
    restricted: true
  });

  // Instantiate socket manager — must run during init so the listener
  // is registered before any socket messages can arrive.
  const socketManager = new AdventureSocketManager();

  globalThis.ClickAdventure = {
    /** @type {typeof ManagerApp} — exposed so socket-manager can instantiate it. */
    ManagerApp,

    /**
     * Opens the scene-graph manager window, or brings the existing one to front.
     * @returns {ManagerApp}
     */
    Manager: () => {
      if (globalThis.ClickAdventure._manager?.rendered) {
        globalThis.ClickAdventure._manager.render();
        return globalThis.ClickAdventure._manager;
      }
      const app = new ManagerApp();
      globalThis.ClickAdventure._manager = app;
      app.render(true);
      return app;
    },

    /** @type {ManagerApp|null} — active instance, kept for cross-app refresh. */
    _manager: null,

    /**
     * Opens the floating navigation HUD, or brings the existing one to front.
     * @returns {NavHudApp}
     */
    HUD: () => {
      if (globalThis.ClickAdventure._hud?.rendered) {
        globalThis.ClickAdventure._hud.render();
        return globalThis.ClickAdventure._hud;
      }
      const hud = new NavHudApp();
      globalThis.ClickAdventure._hud = hud;
      hud.render(true);
      return hud;
    },

    /** @type {NavHudApp|null} — active HUD instance. */
    _hud: null,

    /**
     * Opens the group manager window, or brings the existing one to front.
     * @returns {GroupManagerApp}
     */
    Groups: () => {
      if (globalThis.ClickAdventure._groups?.rendered) {
        globalThis.ClickAdventure._groups.bringToFront();
        return globalThis.ClickAdventure._groups;
      }
      const app = new GroupManagerApp();
      globalThis.ClickAdventure._groups = app;
      app.render(true);
      return app;
    },

    /** @type {GroupManagerApp|null} — active group manager instance. */
    _groups: null,

    /** @type {AdventureSocketManager} — socket handler instance */
    _socket: socketManager
  };
});

/**
 * Inject "Groups" and "Click Adventure" buttons into the Scene Directory sidebar header.
 * Both sit in a flex row below the native action buttons, matching the style of
 * other multi-button directory headers across Foundry modules.
 * Guard against double-injection with a sentinel class check.
 * Restricted to GM users only.
 */
Hooks.on("renderSceneDirectory", (_app, html) => {
  if (!game.user.isGM) return;
  if (html.querySelector(".click-adventure-sidebar-btn")) return;

  const actionButtons =
    html.querySelector(".header-actions") ??
    html.querySelector(".action-buttons");
  if (!actionButtons) return;

  const managerBtn = document.createElement("button");
  managerBtn.type = "button";
  managerBtn.className = "click-adventure-sidebar-btn";
  managerBtn.innerHTML = '<i class="fas fa-map-signs"></i> <span>Click Adventure</span>';
  managerBtn.addEventListener("click", () => ClickAdventure.Manager());

  const groupsBtn = document.createElement("button");
  groupsBtn.type = "button";
  groupsBtn.className = "click-adventure-groups-btn";
  groupsBtn.innerHTML = '<i class="fas fa-layer-group"></i> <span>Groups</span>';
  groupsBtn.addEventListener("click", () => ClickAdventure.Groups());

  actionButtons.appendChild(managerBtn);
  actionButtons.appendChild(groupsBtn);
});
