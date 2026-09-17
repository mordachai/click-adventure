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
 * @returns {string} one of the flat direction strings — see decomposeDirection
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
 * A link/passage's traversal mode is stored as one flat string (e.g. "both", "forward",
 * "forward-blocked", "custom"), decomposed into two independent axes for editing:
 *   - direction: "both" | "forward" | "backward" — which side(s) are the "normal" side.
 *   - state:     "open" | "blocked" | "secret" | "custom" — what happens on the side(s)
 *                that aren't plain "forward"/"backward" travel.
 *
 * decomposeDirection/composeDirection convert between the flat string and the two axes;
 * cycleLinkDirectionAxis/cycleLinkStateAxis step one axis while holding the other fixed —
 * these are what the GM's two controls (direction click, state click) call. A flat string
 * is "both" + a non-open state (e.g. "blocked") when the state applies to both sides, or
 * "<direction>-<state>" (e.g. "forward-blocked") when it applies only to the closed side
 * of a one-way link.
 *
 * State axis reference:
 *   "open"   — Normal traversal, no restriction.
 *   "blocked"— Visible to everyone (⊘ icon, red) but not traversable by players. The GM
 *              can still cross it. Useful for hinting at a passage that isn't open yet.
 *   "secret" — Hidden from players entirely; the GM sees it marked (mask icon, purple) as
 *              a secret passage and can still cross it. Useful for temporarily disabling a
 *              connection, or for a passage players shouldn't know exists yet.
 *   "custom" — Visible to everyone like "blocked", but traversable only once the player
 *              satisfies the passage's `keys` (see evaluatePassageKeys) — an item they must
 *              own, a specific actor, a macro that returns true, or a scene they've
 *              visited. The GM always bypasses the check.
 *
 * Combined with direction, a one-way state (e.g. "forward-blocked") lets a passage be
 * bolted, secret or keyed from one side while remaining perfectly normal from the other —
 * e.g. a door barred from the inside, or a bookshelf that hides a passage on one side but
 * is a plain doorway on the other.
 */

const DIRECTION_AXIS_CYCLE = Object.freeze({ both: "forward", forward: "backward", backward: "both" });
const STATE_AXIS_CYCLE     = Object.freeze({ open: "blocked", blocked: "secret", secret: "custom", custom: "open" });

/**
 * Splits a flat direction string into its direction axis (both/forward/backward) and
 * state axis (open/blocked/secret/custom).
 * @param {string} direction
 * @returns {{dirAxis: "both"|"forward"|"backward", stateAxis: "open"|"blocked"|"secret"|"custom"}}
 */
export function decomposeDirection(direction) {
  if (direction === "both" || direction === "forward" || direction === "backward") {
    return { dirAxis: direction, stateAxis: "open" };
  }
  if (direction === "blocked" || direction === "secret" || direction === "custom") {
    return { dirAxis: "both", stateAxis: direction };
  }
  const match = /^(forward|backward)-(blocked|secret|custom)$/.exec(direction ?? "");
  if (match) return { dirAxis: match[1], stateAxis: match[2] };
  return { dirAxis: "both", stateAxis: "open" };
}

/**
 * Recomposes a direction axis and state axis back into the flat stored string.
 * @param {"both"|"forward"|"backward"} dirAxis
 * @param {"open"|"blocked"|"secret"|"custom"} stateAxis
 * @returns {string}
 */
export function composeDirection(dirAxis, stateAxis) {
  if (stateAxis === "open") return dirAxis;
  if (dirAxis === "both") return stateAxis;
  return `${dirAxis}-${stateAxis}`;
}

/**
 * Cycles the direction axis (both → forward → backward → both) while preserving the
 * current state axis. Called when the GM clicks the direction control.
 * @param {string} direction
 * @returns {string}
 */
export function cycleLinkDirectionAxis(direction) {
  const { dirAxis, stateAxis } = decomposeDirection(direction);
  return composeDirection(DIRECTION_AXIS_CYCLE[dirAxis], stateAxis);
}

/**
 * Cycles the state axis (open → blocked → secret → custom → open) while preserving the
 * current direction axis. Called when the GM clicks the state control.
 * @param {string} direction
 * @returns {string}
 */
export function cycleLinkStateAxis(direction) {
  const { dirAxis, stateAxis } = decomposeDirection(direction);
  return composeDirection(dirAxis, STATE_AXIS_CYCLE[stateAxis]);
}

/**
 * Resolves how a link may be traversed from one specific side, given its effective
 * direction. Single choke point for every direction value — every consumer that gates or
 * labels a destination (the HUD, the "navigate back" check, the Visual Polls integration)
 * goes through this instead of re-deriving the combo logic itself.
 *
 * @param {string} direction - value from getEffectiveDirection(link)
 * @param {"source"|"target"} side - which side of the link this query is "from"
 * @returns {"open"|"blocked"|"secret"|"custom"|"none"} "none" = no route from this side at
 *   all (the closed side of a plain one-way forward/backward link)
 */
export function getLinkStateFromSide(direction, side) {
  const { dirAxis, stateAxis } = decomposeDirection(direction);
  if (dirAxis === "both") return stateAxis;
  const isOpenSide = (dirAxis === "forward" && side === "source") || (dirAxis === "backward" && side === "target");
  if (isOpenSide) return "open";
  return stateAxis === "open" ? "none" : stateAxis;
}

/**
 * Splits a one-way combo direction into its open side and the state of the closed side,
 * for rendering (arrow direction + secondary indicator glyph). Returns null for a plain
 * direction (both/forward/backward) or a both-sided state (blocked/secret/custom).
 *
 * @param {string} direction
 * @returns {{openSide: "forward"|"backward", closedState: "blocked"|"secret"|"custom"}|null}
 */
export function splitOneWayState(direction) {
  const { dirAxis, stateAxis } = decomposeDirection(direction);
  if (dirAxis === "both" || stateAxis === "open") return null;
  return { openSide: dirAxis, closedState: stateAxis };
}

/**
 * Records a scene as visited by the given user — the data behind the "scene visited" key
 * condition (see evaluatePassageKeys). Idempotent: a no-op when already recorded.
 * @param {User} user
 * @param {string|null} sceneId
 * @returns {Promise<void>}
 */
export async function markSceneVisited(user, sceneId) {
  if (!sceneId || !user) return;
  const visited = user.getFlag(MODULE_ID, "visitedSceneIds") ?? [];
  if (visited.includes(sceneId)) return;
  await user.setFlag(MODULE_ID, "visitedSceneIds", [...visited, sceneId]);
}

/**
 * Sets a user's current node position and records the node's active scene as visited by
 * that user, in one call. Every place in the module that moves a user to a node (the HUD's
 * own navigation, guide mode, GM-driven moves in the Manager) should go through this
 * instead of setting the currentNodeId flag directly, so "scene visited" key conditions
 * stay accurate no matter which path the user arrived by.
 *
 * @param {User} user
 * @param {object} node - graph node the user is arriving at
 * @returns {Promise<void>}
 */
export async function setUserCurrentNode(user, node) {
  await user.setFlag(MODULE_ID, "currentNodeId", node.id);
  await markSceneVisited(user, getNodeActiveSceneId(node));
}

/**
 * Evaluates a single "key" condition attached to a custom-state passage, against the
 * current user. Item/actor/scene checks are synchronous ownership/flag lookups; the macro
 * check runs the macro and reads its return value (script macros return whatever their
 * body returns).
 *
 * @param {{type: "item"|"actor"|"macro"|"scene", itemId?: string, itemName?: string,
 *   actorId?: string, macroId?: string, sceneId?: string}} key
 * @returns {Promise<boolean>}
 */
async function _evaluateKeyCondition(key) {
  switch (key.type) {
    case "item": {
      const actor = game.user.character;
      if (!actor) return false;
      return actor.items.some(it => it.id === key.itemId || it.name === key.itemName);
    }
    case "actor":
      return game.user.character?.id === key.actorId;
    case "scene": {
      const visited = game.user.getFlag(MODULE_ID, "visitedSceneIds") ?? [];
      return visited.includes(key.sceneId);
    }
    case "macro": {
      const macro = game.macros.get(key.macroId);
      if (!macro) return false;
      try {
        return (await macro.execute()) === true;
      } catch (err) {
        console.error(`Click Adventure | Key macro "${macro.name}" failed:`, err);
        return false;
      }
    }
    default:
      return false;
  }
}

/**
 * Evaluates a custom-state passage's full key list against the current user, combining
 * results with the passage's keyMode ("AND" = every key required, "OR" = any one key).
 * An empty key list always passes — picking "Custom" before configuring any keys behaves
 * like "Open" rather than soft-locking the passage. The GM always bypasses the check.
 *
 * @param {{keys?: object[], keyMode?: "AND"|"OR"}} passage
 * @returns {Promise<boolean>}
 */
export async function evaluatePassageKeys(passage) {
  if (game.user.isGM) return true;
  const keys = passage?.keys ?? [];
  if (keys.length === 0) return true;
  const results = await Promise.all(keys.map(_evaluateKeyCondition));
  return (passage?.keyMode ?? "AND") === "OR" ? results.some(Boolean) : results.every(Boolean);
}

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
