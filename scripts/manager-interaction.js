/**
 * Drag, pan, and link-draw interaction handlers for the Manager workspace.
 * Extracted from ManagerApp to keep the main shell small.
 *
 * Every function receives the ManagerApp instance as `app` so it can
 * access `app.element`, `app._dragState`, `app._linkState`, `app._panState`, `app._pan`.
 */

import { NodeConfigApp } from "./node-config-app.js";
import { LinkEditorApp } from "./link-editor-app.js";
import { getGraphData, saveGraphData } from "./node-utils.js";
import { bezierOffset, renderLinks, NODE_W, NODE_H } from "./manager-graph.js";

/**
 * Virtual canvas size in pixels.
 * @shared-with-css: --ca-canvas-size in styles/_tokens.css
 */
export const CANVAS_SIZE = 8000;

/** Zoom limits and step size for wheel-based zoom. */
const ZOOM_MIN  = 0.5;
const ZOOM_MAX  = 1.5;
const ZOOM_STEP = 0.1;

/**
 * Applies the combined pan + zoom transform to the canvas element.
 * Single source of truth so every code path produces an identical transform string.
 * @param {HTMLElement} canvas
 * @param {{ x: number, y: number }} pan
 * @param {number} zoom
 */
function applyTransform(canvas, pan, zoom) {
  canvas.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
}

// ---------------------------------------------------------------------------
// Node interaction
// ---------------------------------------------------------------------------

/**
 * Begins a node drag operation.
 * @param {ManagerApp} app
 * @param {MouseEvent} e
 * @param {HTMLElement} nodeEl
 */
export function onNodeMouseDown(app, e, nodeEl) {
  // Let anchor mousedown propagate independently
  if (e.target.classList.contains("ca-anchor")) return;
  e.preventDefault();
  e.stopPropagation();

  const nodeId = nodeEl.dataset.nodeId;

  // Shift+click: toggle selection, do NOT start a drag
  if (e.shiftKey) {
    if (app._selectedNodes.has(nodeId)) {
      app._selectedNodes.delete(nodeId);
      nodeEl.classList.remove("ca-node--selected");
    } else {
      app._selectedNodes.add(nodeId);
      nodeEl.classList.add("ca-node--selected");
    }
    return; // early exit — no drag initiated
  }

  // Normal click on an unselected node: clear selection
  if (!app._selectedNodes.has(nodeId)) {
    clearSelection(app);
  }

  // Start drag — if the node is selected (either was before or just became
  // the only selected node), all selected nodes will move together.
  // If the node was not selected, it drags alone (selection is empty).
  const nodeRect = nodeEl.getBoundingClientRect();
  app._dragState = {
    nodeId,
    nodeEl,
    offsetX: e.clientX - nodeRect.left,
    offsetY: e.clientY - nodeRect.top,
    // Snapshot the starting canvas position of every selected node so we can
    // compute deltas during mousemove without touching the DOM for each.
    groupStartPositions: app._selectedNodes.size > 0
      ? _snapshotGroupPositions(app)
      : null
  };
}

/**
 * Opens NodeConfigApp for the double-clicked node.
 * @param {ManagerApp} app
 * @param {MouseEvent} e
 * @param {HTMLElement} nodeEl
 */
export function onNodeDblClick(app, e, nodeEl) {
  e.preventDefault();
  new NodeConfigApp(nodeEl.dataset.nodeId).render(true);
}

// ---------------------------------------------------------------------------
// Anchor / link-draw
// ---------------------------------------------------------------------------

/**
 * Begins a link-draw operation from the clicked anchor dot.
 * @param {ManagerApp} app
 * @param {MouseEvent} e
 * @param {HTMLElement} anchor
 */
export function onAnchorMouseDown(app, e, anchor) {
  e.preventDefault();
  e.stopPropagation();

  const nodeEl = anchor.closest(".ca-node");
  const workspace = app.element.querySelector(".ca-workspace");
  const wsRect = workspace.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();

  const zoom = app._zoom ?? 1;
  const startX = (anchorRect.left + anchorRect.width  / 2 - wsRect.left - app._pan.x) / zoom;
  const startY = (anchorRect.top  + anchorRect.height / 2 - wsRect.top  - app._pan.y) / zoom;

  const svg = workspace.querySelector(".ca-links-layer");
  const srcAnchor = anchor.dataset.anchor;
  const c = bezierOffset(srcAnchor);

  const tempPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  tempPath.classList.add("ca-temp-link");
  // Degenerate initial path — updated on every mousemove
  tempPath.setAttribute("d", `M ${startX},${startY} C ${startX + c.dx},${startY + c.dy} ${startX},${startY} ${startX},${startY}`);
  svg.appendChild(tempPath);

  app._linkState = {
    sourceId: nodeEl.dataset.nodeId,
    sourceAnchor: srcAnchor,
    sourceLinkType: anchor.dataset.type ?? "navigation",
    startX,
    startY,
    tempLine: tempPath   // property name kept so onDocMouseMove and onDocMouseUp still work
  };
}

// ---------------------------------------------------------------------------
// Document-level move / up
// ---------------------------------------------------------------------------

/**
 * Updates drag position or temp link line as the pointer moves.
 * Document-level listener — fires even when pointer is outside the workspace.
 * @param {ManagerApp} app
 * @param {MouseEvent} e
 */
export function onDocMouseMove(app, e) {
  if (!app._dragState && !app._linkState && !app._panState && !app._selectState) return;

  if (app._panState) {
    const workspace = app.element?.querySelector(".ca-workspace");
    if (!workspace) return;
    const wsW = workspace.clientWidth;
    const wsH = workspace.clientHeight;
    const zoom = app._zoom ?? 1;

    const dx = e.clientX - app._panState.startX;
    const dy = e.clientY - app._panState.startY;

    const newX = Math.min(0, Math.max(-(CANVAS_SIZE * zoom - wsW), app._panState.originX + dx));
    const newY = Math.min(0, Math.max(-(CANVAS_SIZE * zoom - wsH), app._panState.originY + dy));

    app._pan.x = newX;
    app._pan.y = newY;

    const canvas = app.element?.querySelector(".ca-canvas");
    if (canvas) applyTransform(canvas, app._pan, zoom);
    return; // pan and drag are mutually exclusive
  }

  const workspace = app.element?.querySelector(".ca-workspace");
  if (!workspace) return;
  const wsRect = workspace.getBoundingClientRect();

  if (app._selectState) {
    const curX  = e.clientX - wsRect.left;
    const curY  = e.clientY - wsRect.top;
    const startX = app._selectState.startClientX - wsRect.left;
    const startY = app._selectState.startClientY - wsRect.top;

    // Activate the rect only after crossing the drag threshold (5 px).
    if (!app._selectState.active) {
      const dx = Math.abs(e.clientX - app._selectState.startClientX);
      const dy = Math.abs(e.clientY - app._selectState.startClientY);
      if (dx <= 5 && dy <= 5) return;

      app._selectState.active = true;
      workspace.classList.add("ca-workspace--selecting");

      const rectEl = document.createElement("div");
      rectEl.className = "ca-select-rect";
      workspace.appendChild(rectEl);
      app._selectState.rectEl = rectEl;
    }

    const left   = Math.min(startX, curX);
    const top    = Math.min(startY, curY);
    const width  = Math.abs(curX  - startX);
    const height = Math.abs(curY  - startY);
    const { style } = app._selectState.rectEl;
    style.left   = `${left}px`;
    style.top    = `${top}px`;
    style.width  = `${width}px`;
    style.height = `${height}px`;
    return;
  }

  if (app._dragState) {
    const { nodeEl, offsetX, offsetY, groupStartPositions } = app._dragState;

    // Position of the primary dragged node — divide by zoom to get canvas coords
    const zoom = app._zoom ?? 1;
    const rawX = (e.clientX - wsRect.left - app._pan.x - offsetX) / zoom;
    const rawY = (e.clientY - wsRect.top  - app._pan.y - offsetY) / zoom;
    const clampedX = Math.max(0, Math.min(CANVAS_SIZE - NODE_W, Math.round(rawX)));
    const clampedY = Math.max(0, Math.min(CANVAS_SIZE - NODE_H, Math.round(rawY)));
    nodeEl.style.left = `${clampedX}px`;
    nodeEl.style.top  = `${clampedY}px`;

    // If there are other selected nodes, move them by the same delta
    if (groupStartPositions && groupStartPositions.size > 1) {
      const primaryId = app._dragState.nodeId;
      const primaryStart = groupStartPositions.get(primaryId);
      if (primaryStart) {
        const dx = clampedX - primaryStart.x;
        const dy = clampedY - primaryStart.y;
        groupStartPositions.forEach(({ x: sx, y: sy }, id) => {
          if (id === primaryId) return;
          const el = app.element?.querySelector(`.ca-node[data-node-id="${id}"]`);
          if (!el) return;
          el.style.left = `${Math.max(0, Math.min(CANVAS_SIZE - NODE_W, sx + dx))}px`;
          el.style.top  = `${Math.max(0, Math.min(CANVAS_SIZE - NODE_H, sy + dy))}px`;
        });
      }
    }

    renderLinks(app);
  }

  if (app._linkState) {
    const { tempLine: tempPath, startX, startY, sourceAnchor } = app._linkState;
    const linkZoom = app._zoom ?? 1;
    const mx = (e.clientX - wsRect.left - app._pan.x) / linkZoom;
    const my = (e.clientY - wsRect.top  - app._pan.y) / linkZoom;
    const c1 = bezierOffset(sourceAnchor);
    tempPath.setAttribute("d",
      `M ${startX},${startY} C ${startX + c1.dx},${startY + c1.dy} ${mx},${my} ${mx},${my}`
    );
  }
}

/**
 * Finalises drag (saves position) or link draw (saves link or discards).
 * Document-level listener — fires even when pointer is outside the workspace.
 * @param {ManagerApp} app
 * @param {MouseEvent} e
 * @returns {Promise<void>}
 */
export async function onDocMouseUp(app, e) {
  if (app._panState) {
    app._panState = null;
    game.settings.set("click-adventure", "managerPan", { x: app._pan.x, y: app._pan.y, zoom: app._zoom ?? 1 });
    return;
  }

  if (app._selectState) {
    const { active, rectEl, startClientX, startClientY } = app._selectState;
    app._selectState = null;

    const workspace = app.element?.querySelector(".ca-workspace");
    workspace?.classList.remove("ca-workspace--selecting");

    if (!active) {
      // Pure click on the background (no drag) — clear selection.
      clearSelection(app);
      return;
    }

    rectEl?.remove();
    if (!workspace) return;

    const wsRect    = workspace.getBoundingClientRect();
    const zoom      = app._zoom ?? 1;
    // Convert the selection rectangle corners from workspace-relative screen coords
    // to canvas coords so we can test against node positions stored in canvas space.
    const canvasX1  = (Math.min(startClientX, e.clientX) - wsRect.left  - app._pan.x) / zoom;
    const canvasY1  = (Math.min(startClientY, e.clientY) - wsRect.top   - app._pan.y) / zoom;
    const canvasX2  = (Math.max(startClientX, e.clientX) - wsRect.left  - app._pan.x) / zoom;
    const canvasY2  = (Math.max(startClientY, e.clientY) - wsRect.top   - app._pan.y) / zoom;

    // Shift held: add to existing selection; otherwise replace it.
    if (!e.shiftKey) clearSelection(app);

    workspace.querySelectorAll(".ca-node").forEach(nodeEl => {
      // Read current position from inline style set by drag; fall back to 0.
      const nodeX = parseInt(nodeEl.style.left, 10) || 0;
      const nodeY = parseInt(nodeEl.style.top,  10) || 0;
      const overlaps = nodeX < canvasX2 && nodeX + NODE_W > canvasX1 &&
                       nodeY < canvasY2 && nodeY + NODE_H > canvasY1;
      if (overlaps) {
        app._selectedNodes.add(nodeEl.dataset.nodeId);
        nodeEl.classList.add("ca-node--selected");
      }
    });
    return;
  }

  if (app._dragState) {
    const { nodeId, offsetX, offsetY, groupStartPositions } = app._dragState;
    app._dragState = null;

    const workspace = app.element?.querySelector(".ca-workspace");
    const wsRect = workspace?.getBoundingClientRect();
    if (!wsRect) return;

    const dropZoom = app._zoom ?? 1;
    const primaryX = Math.max(0, Math.min(CANVAS_SIZE - NODE_W, Math.round((e.clientX - wsRect.left - app._pan.x - offsetX) / dropZoom)));
    const primaryY = Math.max(0, Math.min(CANVAS_SIZE - NODE_H, Math.round((e.clientY - wsRect.top  - app._pan.y - offsetY) / dropZoom)));

    if (groupStartPositions && groupStartPositions.size > 1) {
      // Batch save all nodes in the group
      const primaryStart = groupStartPositions.get(nodeId);
      const dx = primaryStart ? primaryX - primaryStart.x : 0;
      const dy = primaryStart ? primaryY - primaryStart.y : 0;
      const updates = [];
      groupStartPositions.forEach(({ x: sx, y: sy }, id) => {
        updates.push({
          nodeId: id,
          x: id === nodeId ? primaryX : Math.max(0, Math.min(CANVAS_SIZE - NODE_W, sx + dx)),
          y: id === nodeId ? primaryY : Math.max(0, Math.min(CANVAS_SIZE - NODE_H, sy + dy))
        });
      });
      await saveNodePositions(app, updates);
    } else {
      await saveNodePosition(app, nodeId, primaryX, primaryY);
    }
  }

  if (app._linkState) {
    const { sourceId, sourceAnchor, sourceLinkType, tempLine } = app._linkState;
    app._linkState = null;
    tempLine.remove();

    const targetEl = e.target.closest?.(".ca-node");
    const targetId = targetEl?.dataset?.nodeId;
    if (targetId && targetId !== sourceId) {
      const targetAnchorEl = e.target.closest?.(".ca-anchor");
      // Peek links must connect corner-to-corner — discard if target is not a peek anchor
      if ((sourceLinkType ?? "navigation") === "peek" && targetAnchorEl?.dataset?.type !== "peek") return;
      const targetAnchor = targetAnchorEl?.dataset?.anchor ?? nearestAnchor(e, targetEl);
      await saveLink(app, sourceId, sourceAnchor, targetId, targetAnchor, e.shiftKey, sourceLinkType ?? "navigation");
    }
  }
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Persists the new x/y of a node after a drag.
 * @param {ManagerApp} app
 * @param {string} nodeId
 * @param {number} x
 * @param {number} y
 * @returns {Promise<void>}
 */
export async function saveNodePosition(app, nodeId, x, y) {
  const { sceneId, startNodeId, nodes: rawNodes, links } = getGraphData();
  const nodes = rawNodes.map(n => n.id === nodeId ? { ...n, x, y } : n);
  await saveGraphData({ sceneId, startNodeId, nodes, links });
  renderLinks(app);
}

/**
 * Persists new x/y positions for multiple nodes in a single saveGraphData call.
 * @param {ManagerApp} app
 * @param {Array<{nodeId: string, x: number, y: number}>} updates
 * @returns {Promise<void>}
 */
export async function saveNodePositions(app, updates) {
  const { sceneId, startNodeId, nodes: rawNodes, links } = getGraphData();
  const updateMap = new Map(updates.map(u => [u.nodeId, u]));
  const nodes = rawNodes.map(n => updateMap.has(n.id) ? { ...n, x: updateMap.get(n.id).x, y: updateMap.get(n.id).y } : n);
  await saveGraphData({ sceneId, startNodeId, nodes, links });
  renderLinks(app);
}

/**
 * Persists a new directed link between two anchor points, skipping duplicates.
 * When openEditor is true (Shift held during drag), the LinkEditorApp opens immediately
 * after creation so the user can configure multiple passages in one step.
 * Peek links (type: "peek") have no passages — they are one-way visibility links only.
 * @param {ManagerApp} app
 * @param {string} sourceId
 * @param {string} sourceAnchor
 * @param {string} targetId
 * @param {string} targetAnchor
 * @param {boolean} [openEditor=false]
 * @param {string} [linkType="navigation"]
 * @returns {Promise<void>}
 */
export async function saveLink(app, sourceId, sourceAnchor, targetId, targetAnchor, openEditor = false, linkType = "navigation") {
  const { sceneId, startNodeId, nodes, links } = getGraphData();
  const duplicate = links.some(l =>
    l.sourceId === sourceId && l.sourceAnchor === sourceAnchor &&
    l.targetId === targetId && l.targetAnchor === targetAnchor
  );
  if (duplicate) return;

  const isPeek = linkType === "peek";
  const newLink = isPeek
    ? { sourceId, sourceAnchor, targetId, targetAnchor, type: "peek" }
    : { sourceId, sourceAnchor, targetId, targetAnchor, passages: [{ label: "", direction: "both", state: "open" }] };

  const newLinks = [...links, newLink];
  await saveGraphData({ sceneId, startNodeId, nodes, links: newLinks });
  app.render({ force: true });

  if (openEditor && !isPeek) {
    new LinkEditorApp(newLinks.length - 1).render(true);
  }
}

/**
 * Returns the anchor side closest to the pointer — used when mouseup lands on the
 * node body rather than an anchor dot.
 * @param {MouseEvent} e
 * @param {HTMLElement} nodeEl
 * @returns {string} "top" | "right" | "bottom" | "left"
 */
export function nearestAnchor(e, nodeEl) {
  const r = nodeEl.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const dx = e.clientX - cx;
  const dy = e.clientY - cy;
  return Math.abs(dx) > Math.abs(dy)
    ? (dx > 0 ? "right" : "left")
    : (dy > 0 ? "bottom" : "top");
}

// ---------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------

/**
 * Removes the selected class from all nodes and clears the selection set.
 * @param {ManagerApp} app
 */
export function clearSelection(app) {
  app._selectedNodes.forEach(id => {
    const el = app.element?.querySelector(`.ca-node[data-node-id="${id}"]`);
    el?.classList.remove("ca-node--selected");
  });
  app._selectedNodes.clear();
}

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------

/**
 * Handles mouse wheel events on the workspace to zoom in/out toward the cursor.
 * Keeps the canvas point under the pointer fixed while the rest scales around it.
 * Triggered by the "wheel" event registered in ManagerApp._onRender.
 * @param {WheelEvent} e
 * @param {ManagerApp} app
 */
export function onWorkspaceWheel(e, app) {
  e.preventDefault();

  const workspace = e.currentTarget;
  const canvas    = workspace.querySelector(".ca-canvas");
  if (!canvas) return;
  const wsRect = workspace.getBoundingClientRect();

  // Mouse position relative to workspace top-left corner
  const mx = e.clientX - wsRect.left;
  const my = e.clientY - wsRect.top;

  const oldZoom = app._zoom ?? 1;
  const delta   = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
  const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, parseFloat((oldZoom + delta).toFixed(2))));

  if (newZoom === oldZoom) return;

  // Zoom-to-cursor: the canvas point under the mouse stays fixed
  const ratio = newZoom / oldZoom;
  const rawX  = mx - (mx - app._pan.x) * ratio;
  const rawY  = my - (my - app._pan.y) * ratio;

  // Clamp pan so the canvas never exposes empty space beyond its bounds
  const wsW = workspace.clientWidth;
  const wsH = workspace.clientHeight;
  app._pan.x = Math.min(0, Math.max(-(CANVAS_SIZE * newZoom - wsW), rawX));
  app._pan.y = Math.min(0, Math.max(-(CANVAS_SIZE * newZoom - wsH), rawY));
  app._zoom  = newZoom;

  applyTransform(canvas, app._pan, app._zoom);
  game.settings.set("click-adventure", "managerPan", { x: app._pan.x, y: app._pan.y, zoom: app._zoom });
}

/**
 * Resets zoom to 1:1 and re-clamps pan within the default canvas bounds.
 * Triggered by the ".ca-zoom-reset" button click registered in ManagerApp._onRender.
 * @param {ManagerApp} app
 */
export function onZoomReset(app) {
  const workspace = app.element?.querySelector(".ca-workspace");
  const canvas    = workspace?.querySelector(".ca-canvas");
  if (!canvas) return;

  app._zoom = 1;

  const wsW = workspace.clientWidth;
  const wsH = workspace.clientHeight;
  app._pan.x = Math.min(0, Math.max(-(CANVAS_SIZE - wsW), app._pan.x));
  app._pan.y = Math.min(0, Math.max(-(CANVAS_SIZE - wsH), app._pan.y));

  applyTransform(canvas, app._pan, app._zoom);
  game.settings.set("click-adventure", "managerPan", { x: app._pan.x, y: app._pan.y, zoom: 1 });
}

/**
 * Zooms and pans to fit all nodes within the visible workspace.
 * Computes the bounding box of every node, picks the largest zoom that keeps
 * the whole group visible (clamped to ZOOM_MIN..ZOOM_MAX), then centres the
 * pan on the bounding box.
 * Triggered by the ".ca-zoom-all" button click registered in ManagerApp._onRender.
 * @param {ManagerApp} app
 */
export function onZoomAll(app) {
  const workspace = app.element?.querySelector(".ca-workspace");
  const canvas    = workspace?.querySelector(".ca-canvas");
  if (!canvas) return;

  const { nodes } = getGraphData();
  if (!nodes.length) return;

  /** Canvas-space padding added around the bounding box on each side. */
  const PADDING = 60;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + NODE_W);
    maxY = Math.max(maxY, n.y + NODE_H);
  }

  const contentW = maxX - minX;
  const contentH = maxY - minY;
  const centerX  = minX + contentW / 2;
  const centerY  = minY + contentH / 2;

  const wsW = workspace.clientWidth;
  const wsH = workspace.clientHeight;

  const fitZoom = Math.min(
    wsW / (contentW + PADDING * 2),
    wsH / (contentH + PADDING * 2)
  );
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, parseFloat(fitZoom.toFixed(2))));

  // Place the bounding-box centre at the workspace centre
  const rawPanX = wsW / 2 - centerX * zoom;
  const rawPanY = wsH / 2 - centerY * zoom;

  app._pan.x = Math.min(0, Math.max(-(CANVAS_SIZE * zoom - wsW), rawPanX));
  app._pan.y = Math.min(0, Math.max(-(CANVAS_SIZE * zoom - wsH), rawPanY));
  app._zoom  = zoom;

  applyTransform(canvas, app._pan, app._zoom);
  game.settings.set("click-adventure", "managerPan", { x: app._pan.x, y: app._pan.y, zoom: app._zoom });
}

/**
 * Snapshots the current left/top pixel position of every selected node element.
 * Returns a Map<nodeId, {x, y}> read directly from inline styles set by drag.
 * Falls back to the data-model position if the inline style is not yet set.
 * @param {ManagerApp} app
 * @returns {Map<string, {x: number, y: number}>}
 */
function _snapshotGroupPositions(app) {
  const snapshot = new Map();
  const { nodes } = getGraphData();
  const modelMap = new Map(nodes.map(n => [n.id, n]));
  app._selectedNodes.forEach(id => {
    const el = app.element?.querySelector(`.ca-node[data-node-id="${id}"]`);
    if (!el) return;
    const x = el.style.left ? parseInt(el.style.left, 10) : (modelMap.get(id)?.x ?? 0);
    const y = el.style.top  ? parseInt(el.style.top,  10) : (modelMap.get(id)?.y ?? 0);
    snapshot.set(id, { x, y });
  });
  return snapshot;
}
