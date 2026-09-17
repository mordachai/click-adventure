/**
 * Player occupancy, teleportation, context menu, and navigation request handlers.
 * Extracted from ManagerApp to keep the main shell small.
 *
 * Every function receives the ManagerApp instance as `app` so it can
 * access `app.element`, `app._navRequests`, and trigger renders.
 */

import { getGraphData, setUserCurrentNode, clearVisitedScenes } from "./node-utils.js";
import { isUserLocked, lockUser, unlockUser, shouldLockOnArrival } from "./autolock-utils.js";

// ---------------------------------------------------------------------------
// Occupant map
// ---------------------------------------------------------------------------

/**
 * Builds a map of nodeId → occupant display data for all active non-GM users.
 * name priority: linked actor name → user name.
 * @returns {Map<string, Array<{name: string, color: string}>>}
 */
export function buildOccupants() {
  const map = new Map();
  for (const user of game.users) {
    if (user.isGM || !user.active) continue;
    const nodeId = user.getFlag("click-adventure", "currentNodeId");
    if (!nodeId) continue;

    const name  = user.character?.name ?? user.name;
    const color = user.color?.css ?? user.color ?? "#ffffff";

    if (!map.has(nodeId)) map.set(nodeId, []);
    map.get(nodeId).push({ name, color });
  }
  return map;
}

/**
 * Builds grouped player data for the sidebar panel.
 * Includes GMs in a dedicated bucket and non-GM users split into online/offline.
 * @returns {{ gm: Array, online: Array, offline: Array }}
 *   Each entry: { userId, displayName, color, active, nodeId, nodeLabel, isLocked }
 */
export function buildPlayerPanelData() {
  const { nodes } = getGraphData();
  const toEntry = u => {
    const nodeId = u.getFlag("click-adventure", "currentNodeId") ?? null;
    const node   = nodes.find(n => n.id === nodeId);
    return {
      userId:      u.id,
      displayName: u.character?.name ?? u.name,
      color:       u.color?.css ?? u.color ?? "#ffffff",
      active:      u.active,
      nodeId:      nodeId,
      nodeLabel:   node?.label ?? null,
      isLocked:    isUserLocked(u.id)
    };
  };

  const gms      = game.users.filter(u => u.isGM).map(toEntry);
  const players  = game.users.filter(u => !u.isGM).map(toEntry);

  return {
    gm:      gms,
    online:  players.filter(p => p.active),
    offline: players.filter(p => !p.active)
  };
}

// ---------------------------------------------------------------------------
// Occupant DOM patching
// ---------------------------------------------------------------------------

/**
 * Updates occupant name label strips in-place without triggering a full re-render.
 * Called when a PLAYER_MOVED socket message is received while the manager is open.
 * Safe to call at any time — no-op if the manager is not rendered.
 * @param {ManagerApp} app
 */
export function patchOccupantAvatars(app) {
  if (!app.rendered) return;
  const html = app.element;

  const occupants   = buildOccupants();       // nodeId → [{name, color}]
  const panelData   = buildPlayerPanelData(); // { online: [], offline: [] }

  // ── 1. Update node badges (count + icon, no text labels) ──────────────────
  html.querySelectorAll(".ca-node").forEach(nodeEl => {
    const nodeId = nodeEl.dataset.nodeId;
    const count  = (occupants.get(nodeId) ?? []).length;

    // Remove old occupant labels strip
    nodeEl.querySelector(".ca-node-occupants")?.remove();

    // Get or create the top-left wrapper
    let wrapper = nodeEl.querySelector(".ca-node-top-left");

    // Update or remove the count badge inside the wrapper
    let badge = nodeEl.querySelector(".ca-node-occupant-badge");
    if (count === 0) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "ca-node-occupant-badge";
      // If the wrapper exists, place badge inside it; otherwise fall back to node root
      (wrapper ?? nodeEl).appendChild(badge);
    }
    badge.innerHTML = `<i class="fa-solid fa-people-group"></i><span>${count}</span>`;
  });

  // ── 2. Rebuild player panel rows ──────────────────────────────────────────
  const gmList      = html.querySelector(".ca-player-group--gm .ca-player-list");
  const onlineList  = html.querySelector(".ca-player-group--online .ca-player-list");
  const offlineList = html.querySelector(".ca-player-group--offline .ca-player-list");
  if (!gmList || !onlineList || !offlineList) return;

  _fillPlayerList(gmList,      panelData.gm,      false, app, false);
  _fillPlayerList(onlineList,  panelData.online,  false, app, true);
  _fillPlayerList(offlineList, panelData.offline, true,  app, true);
}

// ---------------------------------------------------------------------------
// Private helpers — panel interaction
// ---------------------------------------------------------------------------

/**
 * Fills a player list element with rows for the given player data array.
 * Shows an empty-state placeholder when the array is empty.
 * Called from patchOccupantAvatars for gm, online, and offline groups.
 * @param {HTMLElement} listEl - The <ul> to populate
 * @param {Array<object>} players - Subset of buildPlayerPanelData()
 * @param {boolean} isOffline - Whether this group is the offline bucket (affects row class + dot title)
 * @param {ManagerApp} app
 * @param {boolean} showLock - Whether to render the lock/unlock button
 */
function _fillPlayerList(listEl, players, isOffline, app, showLock = true) {
  listEl.innerHTML = "";

  if (players.length === 0) {
    const li = document.createElement("li");
    li.className = "ca-player-row ca-player-row--empty";
    li.textContent = isOffline ? "No players offline" : "No players online";
    listEl.appendChild(li);
    return;
  }

  for (const p of players) {
    const li = document.createElement("li");
    li.className = "ca-player-row" + (isOffline ? " ca-player-row--offline" : "");
    li.dataset.userId = p.userId;
    if (p.nodeId) li.dataset.nodeId = p.nodeId;

    const lockBtn = showLock ? `
      <button class="ca-player-lock-btn ${p.isLocked ? "ca-player-lock-btn--locked" : ""}"
              data-user-id="${p.userId}"
              title="${p.isLocked ? "Click to unlock" : "Click to lock"}"
              type="button">
        <i class="fa-solid ${p.isLocked ? "fa-lock" : "fa-lock-open"}"></i>
      </button>` : "";

    li.innerHTML = `
      <span class="ca-player-dot" style="background:${p.color};"
            title="${isOffline ? "Offline" : "Online"}"></span>
      <span class="ca-player-name">${p.displayName}</span>
      ${lockBtn}
    `;

    li.querySelector(".ca-player-lock-btn")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (p.isLocked) {
        await unlockUser(p.userId);
        globalThis.ClickAdventure._socket.notifyLockChanged(p.userId);
      } else {
        await lockUser(p.userId, p.nodeId ?? "");
        globalThis.ClickAdventure._socket.notifyLockChanged(p.userId);
      }
      patchOccupantAvatars(app);
    });

    if (p.nodeId) {
      li.addEventListener("click", () => _focusNode(app, p.nodeId));
    }

    li.addEventListener("mouseenter", () => _setNodeHighlight(app, p.nodeId, true));
    li.addEventListener("mouseleave", () => _setNodeHighlight(app, p.nodeId, false));

    listEl.appendChild(li);
  }
}

/**
 * Centers the canvas viewport on the given node by adjusting app._pan.
 * @param {ManagerApp} app
 * @param {string} nodeId
 */
function _focusNode(app, nodeId) {
  if (!nodeId) return;
  const nodeEl = app.element?.querySelector(`.ca-node[data-node-id="${nodeId}"]`);
  if (!nodeEl) return;

  const workspace = app.element.querySelector(".ca-workspace");
  if (!workspace) return;

  const nodeX = parseFloat(nodeEl.style.left) || 0;
  const nodeY = parseFloat(nodeEl.style.top)  || 0;

  const wRect   = workspace.getBoundingClientRect();
  const wWidth  = wRect.width;
  const wHeight = wRect.height;

  // Desired pan: center the node in the workspace viewport
  const desiredX = (wWidth  / 2) - nodeX - (nodeEl.offsetWidth  / 2);
  const desiredY = (wHeight / 2) - nodeY - (nodeEl.offsetHeight / 2);

  // Clamp: pan must not exceed 0 (would expose area before canvas origin)
  // and must not go below -(CANVAS_SIZE - workspaceSize) (would expose area past canvas end)
  const CANVAS_SIZE = 8000; // must match CANVAS_SIZE constant in manager-interaction.js
  const minX = -(CANVAS_SIZE - wWidth);
  const minY = -(CANVAS_SIZE - wHeight);

  app._pan = {
    x: Math.min(0, Math.max(minX, desiredX)),
    y: Math.min(0, Math.max(minY, desiredY))
  };

  const canvas = app.element.querySelector(".ca-canvas");
  if (canvas) canvas.style.transform = `translate(${app._pan.x}px, ${app._pan.y}px)`;

  // Briefly highlight the node after centering
  _setNodeHighlight(app, nodeId, true);
  setTimeout(() => _setNodeHighlight(app, nodeId, false), 1200);
}

/**
 * Adds or removes the highlight class on a specific node element.
 * @param {ManagerApp} app
 * @param {string|null} nodeId
 * @param {boolean} on
 */
function _setNodeHighlight(app, nodeId, on) {
  if (!nodeId) return;
  const nodeEl = app.element?.querySelector(`.ca-node[data-node-id="${nodeId}"]`);
  nodeEl?.classList.toggle("ca-node--highlighted", on);
}

// ---------------------------------------------------------------------------
// Navigation requests
// ---------------------------------------------------------------------------

/**
 * Approves a pending navigation request: updates the player's flag and emits approval.
 * Triggered by clicking the approve button in the requests drawer.
 * @param {ManagerApp} app
 * @param {string} userId
 * @param {string} toNodeId
 * @returns {Promise<void>}
 */
export async function approveRequest(app, userId, toNodeId) {
  const request = app._navRequests.get(userId);
  if (!request) return;

  app._navRequests.delete(userId);

  const { nodes } = getGraphData();
  const targetNode = nodes.find(n => n.id === toNodeId);

  const user = game.users.get(userId);
  if (user) {
    // Preserve the "came from" context on approval
    if (request.fromNodeId) {
      await user.setFlag("click-adventure", "previousNodeId", request.fromNodeId);
    } else {
      await user.unsetFlag("click-adventure", "previousNodeId");
    }
    if (targetNode) await setUserCurrentNode(user, targetNode);
  }

  globalThis.ClickAdventure._socket.approveNavRequest(userId, toNodeId, targetNode?.sceneId ?? null);
  patchOccupantAvatars(app);
  patchRequestsDrawer(app);
}

/**
 * Approves all pending navigation requests in one action.
 * Iterates a snapshot of the queue so deletions inside approveRequest
 * don't mutate the collection mid-loop.
 * @param {ManagerApp} app
 * @returns {Promise<void>}
 */
export async function onApproveAll(app) {
  const pending = [...app._navRequests.values()];
  for (const request of pending) {
    await approveRequest(app, request.userId, request.toNodeId);
  }
}

/**
 * Rejects a pending navigation request and notifies the player.
 * Triggered by clicking the reject button in the requests drawer.
 * @param {ManagerApp} app
 * @param {string} userId
 */
export function rejectRequest(app, userId) {
  app._navRequests.delete(userId);
  globalThis.ClickAdventure._socket.rejectNavRequest(userId);
  patchRequestsDrawer(app);
}

/**
 * Patches the requests button badge and drawer content in-place after any queue mutation.
 * Avoids a full re-render — mirrors the pattern used by patchOccupantAvatars.
 * Safe to call at any time — no-op if the manager is not rendered.
 * @param {ManagerApp} app
 */
export function patchRequestsDrawer(app) {
  if (!app.rendered) return;
  const html = app.element;
  const count = app._navRequests.size;

  const btn = html.querySelector(".ca-requests-btn");
  if (btn) {
    btn.textContent = count > 0 ? `Requests (${count})` : "Requests";
    btn.classList.toggle("ca-requests-btn--active", count > 0);
  }

  const drawer = html.querySelector(".ca-requests-drawer");
  if (!drawer) return;

  // Sync the approve-all button: create on first request, update count, remove when empty.
  let approveAllBtn = drawer.querySelector(".ca-approve-all-btn");
  if (count === 0) {
    approveAllBtn?.remove();
  } else if (!approveAllBtn) {
    approveAllBtn = document.createElement("button");
    approveAllBtn.className = "ca-approve-all-btn";
    approveAllBtn.type = "button";
    approveAllBtn.textContent = `Approve All (${count})`;
    approveAllBtn.addEventListener("click", () => onApproveAll(app));
    const header = drawer.querySelector(".ca-requests-drawer-header");
    header.insertAdjacentElement("afterend", approveAllBtn);
  } else {
    approveAllBtn.textContent = `Approve All (${count})`;
  }

  const { nodes } = getGraphData();
  const getLabel = id => nodes.find(n => n.id === id)?.label || id;
  const requests = [...app._navRequests.values()].sort((a, b) => a.timestamp - b.timestamp);

  const existing = drawer.querySelector(".ca-requests-list, .ca-requests-empty");
  if (!existing) return;

  if (requests.length === 0) {
    existing.outerHTML = `<div class="ca-requests-empty">No pending requests.</div>`;
    return;
  }

  const ul = document.createElement("ul");
  ul.className = "ca-requests-list";

  for (const r of requests) {
    const li = document.createElement("li");
    li.className = "ca-request-item";
    li.dataset.userId = r.userId;
    li.innerHTML = `
      <span class="ca-request-dot" style="background:${r.userColor};"></span>
      <span class="ca-request-info">
        <strong>${r.userName}</strong>
        <span class="ca-request-route">${getLabel(r.fromNodeId)} → ${getLabel(r.toNodeId)}</span>
      </span>
      <button class="ca-request-approve" data-user-id="${r.userId}" data-node-id="${r.toNodeId}" title="Approve">✓</button>
      <button class="ca-request-reject"  data-user-id="${r.userId}" title="Reject">✗</button>
    `;
    li.querySelector(".ca-request-approve").addEventListener("click", () =>
      approveRequest(app, r.userId, r.toNodeId));
    li.querySelector(".ca-request-reject").addEventListener("click", () =>
      rejectRequest(app, r.userId));
    ul.appendChild(li);
  }

  existing.replaceWith(ul);
}

// ---------------------------------------------------------------------------
// Active node / view scene
// ---------------------------------------------------------------------------

/**
 * Sets the GM's current position flag to the clicked node.
 * Only updates the current user's flag — does not affect other players.
 * @param {ManagerApp} app
 * @param {string} nodeId
 * @returns {Promise<void>}
 */
export async function onSetActiveNode(app, nodeId) {
  if (!nodeId) return;
  const { nodes } = getGraphData();
  const node = nodes.find(n => n.id === nodeId);
  if (node) await setUserCurrentNode(game.user, node);
  app.render({ force: true });
  globalThis.ClickAdventure._hud?.render({ force: true });
}

// ---------------------------------------------------------------------------
// Context menu & teleport
// ---------------------------------------------------------------------------

/**
 * Shows a context menu on right-click over a node with options to teleport players.
 * @param {ManagerApp} app
 * @param {MouseEvent} e
 * @param {string} nodeId
 */
export function onNodeContextMenu(app, e, nodeId) {
  document.querySelector(".ca-context-menu")?.remove();

  const players = game.users.filter(u => !u.isGM && u.active);
  if (players.length === 0) return;

  const { nodes } = getGraphData();
  const node = nodes.find(n => n.id === nodeId);
  if (!node) return;

  const menu = document.createElement("div");
  menu.className = "ca-context-menu";
  menu.style.left = `${e.clientX}px`;
  menu.style.top  = `${e.clientY}px`;

  const header = document.createElement("div");
  header.className = "ca-context-menu-header";
  header.textContent = `Teleport to "${node.label || nodeId}"`;
  menu.appendChild(header);

  menu.appendChild(Object.assign(document.createElement("div"), { className: "ca-context-menu-divider" }));

  const sendAll = document.createElement("div");
  sendAll.className = "ca-context-menu-item ca-context-menu-item--send-all";
  sendAll.textContent = "Send all here";
  sendAll.addEventListener("click", () => {
    menu.remove();
    onSendAllToNode(app, node, players);
  });
  menu.appendChild(sendAll);

  menu.appendChild(Object.assign(document.createElement("div"), { className: "ca-context-menu-divider" }));

  for (const user of players) {
    const currentNodeId = user.getFlag("click-adventure", "currentNodeId");
    const isHere = currentNodeId === nodeId;

    const item = document.createElement("div");
    item.className = "ca-context-menu-item" + (isHere ? " ca-context-menu-item--active" : "");

    const dot = document.createElement("span");
    dot.className = "ca-context-menu-dot";
    dot.style.background = user.color?.css ?? user.color ?? "#fff";

    const label = document.createElement("span");
    label.textContent = user.name;

    item.appendChild(dot);
    item.appendChild(label);

    if (isHere) {
      const badge = document.createElement("span");
      badge.className = "ca-context-menu-badge";
      badge.textContent = "here";
      item.appendChild(badge);
    } else {
      item.addEventListener("click", () => {
        menu.remove();
        onTeleportPlayer(app, user, nodeId);
      });
    }

    menu.appendChild(item);
  }

  document.body.appendChild(menu);

  const closeMenu = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener("mousedown", closeMenu);
    }
  };
  // Delay one tick so this very mousedown event doesn't immediately close the menu
  setTimeout(() => document.addEventListener("mousedown", closeMenu), 0);
}

/**
 * Moves all provided active players to a target node.
 * Reuses the same flag + socket pattern as onTeleportPlayer.
 * @param {ManagerApp} app
 * @param {object} targetNode
 * @param {User[]} players
 * @returns {Promise<void>}
 */
export async function onSendAllToNode(app, targetNode, players) {
  const { nodes } = getGraphData();
  for (const user of players) {
    // Capture origin BEFORE overwriting the flag.
    const fromNodeId  = user.getFlag("click-adventure", "currentNodeId") ?? null;
    const fromNode    = nodes.find(n => n.id === fromNodeId);
    const fromSceneId = fromNode?.sceneId ?? null;

    // Teleport clears the "came from" context
    await user.unsetFlag("click-adventure", "previousNodeId");
    await setUserCurrentNode(user, targetNode);

    // Apply autolock if the destination node requires it (Risk: teleport bypasses player-side check)
    if (shouldLockOnArrival(targetNode)) {
      await lockUser(user.id, targetNode.id);
      globalThis.ClickAdventure._socket.notifyLockChanged(user.id);
    }

    if (targetNode.sceneId) {
      globalThis.ClickAdventure._socket.teleportUser(targetNode.sceneId, user.id);
      // GM is the executor — call directly (socket.io does not echo to emitter).
      await globalThis.ClickAdventure._socket._handleMoveToken({
        userId: user.id,
        fromSceneId,
        toSceneId: targetNode.sceneId
      });
    } else {
      globalThis.ClickAdventure._socket.notifyHudRefresh(user.id);
    }
  }

  patchOccupantAvatars(app);
}

// ---------------------------------------------------------------------------
// Bulk lock / unlock
// ---------------------------------------------------------------------------

/**
 * Locks all non-GM users that are currently online (active).
 * Mirrors the per-user pattern in _fillPlayerList: lockUser → notifyLockChanged.
 * @param {ManagerApp} app
 * @returns {Promise<void>}
 */
export async function lockAllPlayers(app) {
  const players = game.users.filter(u => !u.isGM && u.active);
  for (const user of players) {
    const nodeId = user.getFlag("click-adventure", "currentNodeId") ?? "";
    await lockUser(user.id, nodeId);
    globalThis.ClickAdventure._socket.notifyLockChanged(user.id);
  }
  patchOccupantAvatars(app);
}

/**
 * Unlocks all non-GM users (online and offline).
 * Unlocking an already-unlocked user is a no-op per unlockUser implementation.
 * @param {ManagerApp} app
 * @returns {Promise<void>}
 */
export async function unlockAllPlayers(app) {
  const players = game.users.filter(u => !u.isGM);
  for (const user of players) {
    await unlockUser(user.id);
    globalThis.ClickAdventure._socket.notifyLockChanged(user.id);
  }
  patchOccupantAvatars(app);
}

/**
 * Clears every non-GM user's visited-scene history so "scene visited" key conditions
 * (see evaluatePassageKeys) re-lock — lets the GM restart a playthrough fresh.
 * Shows a confirmation dialog first, mirroring onResetMacros.
 * @returns {Promise<void>}
 */
export async function onResetVisitedScenes() {
  const players = game.users.filter(u => !u.isGM);
  const count = players.filter(u => (u.getFlag("click-adventure", "visitedSceneIds") ?? []).length > 0).length;

  if (count === 0) {
    ui.notifications.info("Click Adventure: No visited-scene history to reset.");
    return;
  }

  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Reset Visited Scenes" },
    classes: ["click-adventure", "ca-dialog"],
    content: `<p>This will clear the visited-scene history for <strong>${count} player(s)</strong>, re-locking any "scene visited" key conditions.</p><p>Are you sure?</p>`,
    yes: { class: "ca-btn ca-btn--danger" },
    no:  { class: "ca-btn ca-btn--quiet" },
    rejectClose: false
  });
  if (!confirmed) return;

  for (const user of players) {
    await clearVisitedScenes(user);
  }
  ui.notifications.info(`Click Adventure: Visited-scene history cleared for ${count} player(s).`);
}

/**
 * Teleports a specific player to a target node.
 * Updates their currentNodeId flag and notifies their client via socket.
 * @param {ManagerApp} app
 * @param {User} user
 * @param {string} nodeId
 * @returns {Promise<void>}
 */
export async function onTeleportPlayer(app, user, nodeId) {
  const { nodes } = getGraphData();
  const targetNode = nodes.find(n => n.id === nodeId);
  if (!targetNode) return;

  // Capture origin BEFORE overwriting the flag.
  const fromNodeId  = user.getFlag("click-adventure", "currentNodeId") ?? null;
  const fromNode    = nodes.find(n => n.id === fromNodeId);
  const fromSceneId = fromNode?.sceneId ?? null;

  // Teleport clears the "came from" context
  await user.unsetFlag("click-adventure", "previousNodeId");
  await setUserCurrentNode(user, targetNode);

  // Apply autolock if the destination node requires it (Risk: teleport bypasses player-side check)
  if (shouldLockOnArrival(targetNode)) {
    await lockUser(user.id, nodeId);
    globalThis.ClickAdventure._socket.notifyLockChanged(user.id);
  }

  if (targetNode.sceneId) {
    await globalThis.ClickAdventure._socket.teleportUser(targetNode.sceneId, user.id);
    // GM is the executor — call directly (socket.io does not echo to emitter).
    await globalThis.ClickAdventure._socket._handleMoveToken({
      userId: user.id,
      fromSceneId,
      toSceneId: targetNode.sceneId
    });
  } else {
    await globalThis.ClickAdventure._socket.notifyHudRefresh(user.id);
  }

  patchOccupantAvatars(app);
}


