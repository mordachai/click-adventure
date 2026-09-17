/**
 * Shared utility for resolving a node's active image source, reading link passage data,
 * and syncing a node's managed background tile with its current active image.
 * Kept in a separate module to avoid circular imports between manager-app,
 * node-config-app, nav-hud-app, and the module entry point.
 */

import { MODULE_ID } from "./constants.js";
import { buildSceneData } from "./scene-template.js";

/**
 * Returns the active image src for a node.
 * Supports both the new multi-image schema (images[]) and the legacy imageSrc field.
 *
 * @param {object} node
 * @returns {string}
 */
export function getNodeActiveImage(node) {
  if (Array.isArray(node.images) && node.images.length > 0) {
    const idx = node.activeImageIndex ?? 0;
    return node.images[idx]?.src ?? "";
  }
  return node.imageSrc ?? "";
}

/**
 * Returns true when a link carries more than one passage, or when the link was explicitly
 * promoted to multi-passage mode via the editor (forceMulti flag set on save).
 * Multi-passage links open the LinkEditorApp instead of cycling direction on click.
 *
 * @param {object} link
 * @returns {boolean}
 */
export function isMultiPassage(link) {
  return link.forceMulti === true || (link.passages?.length ?? 0) > 1;
}

/**
 * Returns the effective traversal direction for a single-passage link.
 * Falls back to the legacy flat `direction` field for links not yet migrated.
 *
 * @param {object} link
 * @returns {string} "both" | "forward" | "backward" | "blocked"
 */
export function getEffectiveDirection(link) {
  return link.passages?.[0]?.direction ?? link.direction ?? "both";
}

/**
 * Syncs the managed background tile in a node's Foundry Scene with the node's
 * current active image. Creates the tile if missing, removes it when there is no
 * active image, and updates texture.src when the image changes.
 *
 * The managed tile is identified by the flag "click-adventure.managed" so that
 * GM-placed tiles in the same scene are never touched.
 *
 * Called from NodeConfigApp._saveActiveIndex (immediate image switch) and
 * NodeConfigApp._saveAll (label/image save).
 *
 * @param {object} node - Graph node with optional sceneId and images array.
 * @returns {Promise<void>}
 */
export async function syncNodeTile(node) {
  if (!node.sceneId) return;
  const scene = game.scenes.get(node.sceneId);
  if (!scene) return;

  const rawImage = getNodeActiveImage(node);
  const activeImage = rawImage || null;

  const tile = scene.tiles.find(t => t.getFlag(MODULE_ID, "managed"));

  if (activeImage) {
    if (!tile) {
      const baseTile = buildSceneData("").tiles[0];
      await scene.createEmbeddedDocuments("Tile", [{
        ...baseTile,
        texture: { ...baseTile.texture, src: activeImage },
        locked: true,
        flags: { [MODULE_ID]: { managed: true } }
      }]);
    } else if (tile.texture.src !== activeImage) {
      await tile.update({ texture: { src: activeImage } });
    }
  } else if (tile) {
    await tile.delete();
  }
}

/**
 * Persists a new activeImageIndex for a node and syncs its managed background tile.
 * Extracted from NodeConfigApp._saveActiveIndex so the HUD can reuse it without
 * instantiating the config panel.
 *
 * @param {string} nodeId - graph node id
 * @param {number} index  - index into the node's images array
 * @returns {Promise<void>}
 */
export async function setNodeActiveImageIndex(nodeId, index) {
  const { sceneId, startNodeId, nodes, links } = getGraphData();
  const updatedNodes = nodes.map(n => {
    if (n.id !== nodeId) return n;
    // An image and a linked scene can't both be "active" at once — picking an image
    // reverts the node to its own scene.
    return { ...n, activeImageIndex: index, activeLinkedSceneId: null };
  });
  await saveGraphData({ sceneId, startNodeId, nodes: updatedNodes, links });
  const updatedNode = updatedNodes.find(n => n.id === nodeId);
  if (updatedNode) await syncNodeTile(updatedNode);
}

/**
 * Resolves the id of the Foundry Scene a node currently shows: the linked scene marked
 * active via setNodeActiveLinkedScene, falling back to the node's own scene. Unlike
 * images (a texture swap within one scene), a linked scene is a whole separate Scene,
 * so navigation needs to know which one is actually "current" for this node.
 *
 * @param {object} node
 * @returns {string|null}
 */
export function getNodeActiveSceneId(node) {
  if (!node) return null;
  const active = node.linkedScenes?.find(ls => ls.id === node.activeLinkedSceneId);
  return active?.sceneId ?? node.sceneId ?? null;
}

/**
 * Persists which linked scene (or none) is currently active for a node, so navigating
 * away and back shows the last one the GM picked instead of always reverting to the
 * node's own scene. Mirrors setNodeActiveImageIndex.
 *
 * @param {string} nodeId
 * @param {string|null} linkedSceneId - id of a linkedScenes[] entry, or null to revert
 *   to the node's own scene
 * @returns {Promise<void>}
 */
export async function setNodeActiveLinkedScene(nodeId, linkedSceneId) {
  const { sceneId, startNodeId, nodes, links } = getGraphData();
  const updatedNodes = nodes.map(n => {
    if (n.id !== nodeId) return n;
    return { ...n, activeLinkedSceneId: linkedSceneId };
  });
  await saveGraphData({ sceneId, startNodeId, nodes: updatedNodes, links });
}

/**
 * Ordered direction cycle used when the GM clicks a link to change its traversal mode.
 * Each key is the current state; the value is the next state in the cycle.
 * All 9 states are persisted in the graph data — none is display-only.
 *
 * State reference:
 *   "both"             — Bidirectional. Players on either side see the link and can traverse it.
 *   "forward"          — One-way: source → target only. Players on the target side do not see it.
 *   "backward"         — One-way: target → source only. Players on the source side do not see it.
 *   "forward-blocked"  — Source → target is open and visible to everyone. Target → source is
 *                        completely hidden from players; the GM sees it as a secret passage.
 *   "backward-blocked" — Target → source is open and visible to everyone. Source → target is
 *                        completely hidden from players; the GM sees it as a secret passage.
 *   "forward-locked"   — Source → target is open and visible to everyone. Target → source is
 *                        visible (lock icon ⊘) but not navigable.
 *   "backward-locked"  — Target → source is open and visible to everyone. Source → target is
 *                        visible (lock icon ⊘) but not navigable.
 *   "blocked"          — Completely hidden on both sides. Does not appear in the HUD for
 *                        anyone. Useful for temporarily disabling a connection without
 *                        deleting it.
 *   "locked"           — Visible on both sides (lock icon ⊘) but not navigable from either.
 *                        Players can see the destination but clicking it does nothing.
 *                        Useful for hinting at a passage that hasn't been unlocked yet.
 *
 * The four "-blocked"/"-locked" combos let a passage be bolted, blocked or secret from one
 * side while remaining perfectly normal from the other — e.g. a door barred from the inside,
 * or a bookshelf that hides a passage on one side but is a plain doorway on the other.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const DIRECTION_CYCLE = Object.freeze({
  both:                "forward",            // free → one-way forward
  forward:             "forward-blocked",    // one-way forward → forward open, backward secret
  "forward-blocked":   "forward-locked",     // forward open, backward secret → backward locked
  "forward-locked":    "backward",           // forward open, backward locked → one-way backward
  backward:            "backward-blocked",   // one-way backward → backward open, forward secret
  "backward-blocked":  "backward-locked",    // backward open, forward secret → forward locked
  "backward-locked":   "blocked",            // backward open, forward locked → completely hidden
  blocked:             "locked",             // hidden → visible but not navigable
  locked:              "both",               // locked → free (cycle restarts)
});

/**
 * Resolves how a link may be traversed from one specific side, given its effective
 * direction. Single choke point for the 5 legacy states plus the 4 one-way block/lock
 * combos in {@link DIRECTION_CYCLE} — every consumer that gates or labels a destination
 * (the HUD, the "navigate back" check, the Visual Polls integration) goes through this
 * instead of re-deriving the combo logic itself.
 *
 * @param {string} direction - value from getEffectiveDirection(link)
 * @param {"source"|"target"} side - which side of the link this query is "from"
 * @returns {"open"|"locked"|"blocked"|"none"} "none" = no route from this side at all
 *   (the closed side of a plain one-way forward/backward link)
 */
export function getLinkStateFromSide(direction, side) {
  switch (direction) {
    case "both":     return "open";
    case "blocked":  return "blocked";
    case "locked":   return "locked";
    case "forward":  return side === "source" ? "open" : "none";
    case "backward": return side === "target" ? "open" : "none";
    case "forward-blocked":  return side === "source" ? "open" : "blocked";
    case "backward-blocked": return side === "target" ? "open" : "blocked";
    case "forward-locked":   return side === "source" ? "open" : "locked";
    case "backward-locked":  return side === "target" ? "open" : "locked";
    default: return "none";
  }
}

/**
 * Splits a one-way block/lock combo direction into its open side and the state of the
 * closed side, for rendering (arrow direction + secondary indicator glyph). Returns null
 * for every other direction value (both/forward/backward/blocked/locked/peek).
 *
 * @param {string} direction
 * @returns {{openSide: "forward"|"backward", closedState: "blocked"|"locked"}|null}
 */
export function splitOneWayState(direction) {
  switch (direction) {
    case "forward-blocked":  return { openSide: "forward",  closedState: "blocked" };
    case "backward-blocked": return { openSide: "backward", closedState: "blocked" };
    case "forward-locked":   return { openSide: "forward",  closedState: "locked"  };
    case "backward-locked":  return { openSide: "backward", closedState: "locked"  };
    default: return null;
  }
}

/** Cycle used for individual passages inside a multi-passage link. "blocked" is excluded
 *  because the "✕ Remove passage" button already serves that purpose more clearly.
 *  both → forward → backward → locked → both
 */
export const PASSAGE_DIRECTION_CYCLE = Object.freeze({
  both:     "forward",
  forward:  "backward",
  backward: "locked",
  locked:   "both",
});

/**
 * Returns the active adventure graph as a plain object.
 * Reads from the multi-graph collection (`click-adventure.graphs`) and resolves
 * the active entry by `activeGraphId`. Falls back to the first graph if the id
 * is not found (guards against stale ids after a delete).
 *
 * @returns {{ sceneId: string, startNodeId: string, nodes: object[], links: object[] }}
 */
export function getGraphData() {
  const col = game.settings.get(MODULE_ID, "graphs");
  const raw = typeof col?.toObject === "function" ? col.toObject() : (col ?? {});
  const active = (raw.graphs ?? []).find(g => g.id === raw.activeGraphId)
    ?? raw.graphs?.[0]
    ?? {};
  return {
    sceneId:     "",
    startNodeId: active.startNodeId ?? "",
    nodes:       active.nodes       ?? [],
    links:       active.links       ?? []
  };
}

/**
 * Returns the full active graph entry (including its `id` and `name`), unlike
 * {@link getGraphData} which strips those fields. Needed when an operation must
 * resolve the group's per-group Scene folder (keyed by `id`).
 *
 * @returns {{ id: string, name: string, startNodeId: string, nodes: object[], links: object[] }|null}
 *   The active group, or null when the world has no groups yet.
 */
export function getActiveGroup() {
  const col = game.settings.get(MODULE_ID, "graphs");
  const raw = typeof col?.toObject === "function" ? col.toObject() : (col ?? {});
  return (raw.graphs ?? []).find(g => g.id === raw.activeGraphId)
    ?? raw.graphs?.[0]
    ?? null;
}

/**
 * Merges a partial patch into the active graph and persists the collection.
 * Only the active graph entry is modified; all other groups remain unchanged.
 *
 * If no groups exist yet (fresh world), a "Default" group is created automatically
 * so that the very first save (node add, folder import, sync, etc.) is never lost.
 *
 * @param {Partial<{ startNodeId: string, nodes: object[], links: object[] }>} patch
 * @returns {Promise<void>}
 */
export async function saveGraphData(patch) {
  const col = game.settings.get(MODULE_ID, "graphs");
  const raw = typeof col?.toObject === "function" ? col.toObject() : (col ?? {});

  let graphs        = raw.graphs        ?? [];
  let activeGraphId = raw.activeGraphId ?? "";

  // Auto-provision a Default group on the very first write so data is never silently dropped.
  if (graphs.length === 0) {
    const defaultGroup = {
      id:          foundry.utils.randomID(),
      name:        "Default",
      startNodeId: "",
      nodes:       [],
      links:       []
    };
    graphs        = [defaultGroup];
    activeGraphId = defaultGroup.id;
  }

  const updatedGraphs = graphs.map(g =>
    g.id === activeGraphId ? { ...g, ...patch } : g
  );

  await game.settings.set(MODULE_ID, "graphs", { activeGraphId, graphs: updatedGraphs });
}

/**
 * Fires the macro attached to either the active image or the active linked scene
 * of a node, when that macro's trigger matches the provided trigger string.
 * Executes locally on the calling client — never via socket.
 *
 * Called after navigation events to implement per-image/per-scene macro triggers.
 *
 * @param {object} node          - graph node object
 * @param {string} trigger       - "gm-activate" | "player-view" | "gm-view" | "gm-any"
 * @param {string|null} sceneId  - the sceneId being viewed/activated (used to match linked scenes)
 * @returns {Promise<void>}
 */
export async function fireActiveItemMacro(node, trigger, sceneId = null) {
  const images = Array.isArray(node?.images) ? node.images : [];
  const activeImg = images[node?.activeImageIndex ?? 0];
  await _tryFireMacro(activeImg?.macro, trigger);

  if (sceneId) {
    const ls = (node?.linkedScenes ?? []).find(s => s.sceneId === sceneId);
    await _tryFireMacro(ls?.macro, trigger);
  }
}

/**
 * Decides whether a configured macro trigger fires for the trigger being dispatched.
 * "gm-any" is the GM-side wildcard — it covers "gm-view" and "gm-activate" only.
 * It must never match "player-view", or a macro the GM marked GM-only would run on
 * the player's client.
 *
 * @param {string} entryTrigger - trigger stored on the macro entry
 * @param {string} trigger      - trigger being dispatched
 * @returns {boolean}
 */
function _triggerMatches(entryTrigger, trigger) {
  if (entryTrigger === trigger) return true;
  return entryTrigger === "gm-any" && (trigger === "gm-view" || trigger === "gm-activate");
}

/**
 * @param {{ macroId: string, trigger: string }|null|undefined} macroEntry
 * @param {string} trigger
 * @returns {Promise<void>}
 */
async function _tryFireMacro(macroEntry, trigger) {
  if (!macroEntry) return;
  if (!_triggerMatches(macroEntry.trigger, trigger)) return;
  const macro = game.macros.get(macroEntry.macroId);
  if (!macro) {
    console.warn(`Click Adventure | Macro ${macroEntry.macroId} not found — was it deleted?`);
    return;
  }
  try {
    await macro.execute();
  } catch (err) {
    console.error(`Click Adventure | Macro "${macro.name}" failed:`, err);
  }
}

/**
 * Fires all node-level macros whose trigger matches the provided trigger string.
 * Respects executeMode: "once" macros are skipped if already executed.
 * Marks executed "once" macros and persists the updated node state.
 *
 * Called after fireActiveItemMacro on every arrival: onViewScene and onActivateScene
 * in the manager, and NavHudApp._navigateTo plus the socket arrival handlers.
 *
 * @param {object} node    - graph node object
 * @param {string} trigger - "gm-activate" | "player-view" | "gm-view" | "gm-any"
 * @returns {Promise<void>}
 */
export async function fireNodeMacros(node, trigger) {
  if (!Array.isArray(node?.nodeMacros) || node.nodeMacros.length === 0) return;

  const executedOnceIds = [];

  for (const entry of node.nodeMacros) {
    if (!_triggerMatches(entry.trigger, trigger)) continue;
    if (entry.executeMode === "once" && entry.executedOnce === true) continue;

    const macro = game.macros.get(entry.macroId);
    if (!macro) {
      console.warn(`Click Adventure | Node macro ${entry.macroId} not found.`);
      continue;
    }
    try {
      await macro.execute();
    } catch (err) {
      console.error(`Click Adventure | Node macro "${macro.name}" failed:`, err);
    }

    if (entry.executeMode === "once") {
      entry.executedOnce = true;
      executedOnceIds.push(entry.id);
    }
  }

  if (executedOnceIds.length === 0) return;

  if (game.user.isGM) {
    const { sceneId, startNodeId, nodes, links } = getGraphData();
    const updatedNodes = nodes.map(n =>
      n.id === node.id ? { ...n, nodeMacros: node.nodeMacros } : n
    );
    await saveGraphData({ sceneId, startNodeId, nodes: updatedNodes, links });
  } else {
    // "graphs" is a world-scoped setting — players cannot write it. Ask the GM to
    // persist the executedOnce marks, same proxy pattern as REQUEST_LOCK.
    globalThis.ClickAdventure._socket.emitMacroExecuted({
      nodeId:   node.id,
      entryIds: executedOnceIds
    });
  }
}
