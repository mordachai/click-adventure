/**
 * SVG link rendering and Bézier geometry for the Manager workspace.
 * Extracted from ManagerApp to keep the main shell small.
 *
 * Every function receives the ManagerApp instance as `app` so it can
 * access `app.element`, `app._pan`, and sibling methods via delegation.
 */

import { LinkEditorApp } from "./link-editor-app.js";
import { getGraphData, saveGraphData, isMultiPassage, cyclePassageDirection, cyclePassageState, decomposeDirection, splitOneWayState } from "./node-utils.js";

/**
 * Composes a passage's direction+state into the old flat direction string, purely so the
 * existing rendering branches below (and their matching CSS in links.css, keyed on those
 * flat strings) can be reused unchanged. Rendering convenience only — passage.direction/
 * passage.state (see getPassageStateFromSide in node-utils.js) are the actual source of
 * truth for gameplay.
 *
 * @param {string} direction
 * @param {string} state
 * @returns {string} a flat direction string consumable by decomposeDirection/splitOneWayState
 */
function _composeDirectionForRender(direction, state) {
  if (direction === "both") return state === "open" ? "both" : state;
  return state === "open" ? direction : `${direction}-${state}`;
}

/**
 * Glyph for a link's state axis, used by both the both-sided indicator and the one-way
 * combo's secondary closed-side indicator on the Manager canvas. "blocked" is a plain
 * Unicode character (⊘) so it can be tinted via SVG `fill`. "secret" and "custom" use
 * literal Font Awesome glyph codepoints instead of emoji (🎭/🔑) — color emoji ignore
 * `fill` entirely and always render in their fixed palette, which silently broke the
 * purple/blue tinting for those two states; see the matching font-family rule in links.css.
 * @param {"blocked"|"secret"|"custom"} state
 * @returns {string}
 */
function _stateGlyph(state) {
  switch (state) {
    case "blocked": return "⊘";
    case "secret":  return ""; // fa-mask (solid) — matches the HUD/Passage Editor secret icon
    case "custom":  return ""; // fa-key (solid) — matches the HUD custom icon
    default:        return "?";
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * CSS custom property backing a state's color, matching the fills used elsewhere in
 * links.css (state names vs. var names don't match 1:1 — see the file header there).
 * @param {"open"|"blocked"|"secret"|"custom"} state
 * @returns {string}
 */
function _stateColorVar(state) {
  switch (state) {
    case "blocked": return "--ca-state-locked";
    case "secret":  return "--ca-state-blocked";
    case "custom":  return "--ca-state-custom";
    default:        return "--ca-state-open";
  }
}

/**
 * Appends a userSpace linearGradient running from the open endpoint of a one-way combo
 * (green) to its closed endpoint (the closed side's state color), so the path itself shows
 * both halves of the combo instead of a single flat color.
 * @param {SVGDefsElement} defs
 * @param {string} id
 * @param {{x:number,y:number}} openPoint
 * @param {{x:number,y:number}} closedPoint
 * @param {"blocked"|"secret"|"custom"} closedState
 */
function _makeGradient(defs, id, openPoint, closedPoint, closedState) {
  const grad = document.createElementNS(SVG_NS, "linearGradient");
  grad.setAttribute("id", id);
  grad.setAttribute("gradientUnits", "userSpaceOnUse");
  grad.setAttribute("x1", openPoint.x);
  grad.setAttribute("y1", openPoint.y);
  grad.setAttribute("x2", closedPoint.x);
  grad.setAttribute("y2", closedPoint.y);
  const stop1 = document.createElementNS(SVG_NS, "stop");
  stop1.setAttribute("offset", "0%");
  stop1.setAttribute("style", `stop-color: var(${_stateColorVar("open")})`);
  const stop2 = document.createElementNS(SVG_NS, "stop");
  stop2.setAttribute("offset", "100%");
  stop2.setAttribute("style", `stop-color: var(${_stateColorVar(closedState)})`);
  grad.appendChild(stop1);
  grad.appendChild(stop2);
  defs.appendChild(grad);
}

/**
 * Builds one visible link `<path>` for a single passage's composed direction string.
 * A plain open or flat same-state-both-sides direction gets its color from the matching
 * `data-direction` rule in links.css, same as before. A one-way combo (open one side,
 * blocked/secret/custom the other) instead gets a green→state-color gradient stroke via
 * `_makeGradient`, oriented so the gradient's green end sits on the combo's open side
 * regardless of whether that's the source or target endpoint.
 * @param {SVGDefsElement} defs
 * @param {string} gradKeyId — unique id fragment for this path's gradient, if it needs one
 * @param {{x:number,y:number}} p1
 * @param {{dx:number,dy:number}} c1
 * @param {{x:number,y:number}} p2
 * @param {{dx:number,dy:number}} c2
 * @param {string} direction — flat direction string from _composeDirectionForRender
 * @returns {SVGPathElement}
 */
function _createLinkPath(defs, gradKeyId, p1, c1, p2, c2, direction) {
  const d = `M ${p1.x},${p1.y} C ${p1.x + c1.dx},${p1.y + c1.dy} ${p2.x + c2.dx},${p2.y + c2.dy} ${p2.x},${p2.y}`;
  const path = document.createElementNS(SVG_NS, "path");
  path.classList.add("ca-link");
  path.setAttribute("d", d);
  path.dataset.direction = direction;
  path.style.pointerEvents = "none";

  const oneWay = splitOneWayState(direction);
  if (oneWay) {
    const openPoint = oneWay.openSide === "forward" ? p1 : p2;
    const closedPoint = oneWay.openSide === "forward" ? p2 : p1;
    const gradId = `ca-link-grad-${gradKeyId}`;
    _makeGradient(defs, gradId, openPoint, closedPoint, oneWay.closedState);
    path.style.stroke = `url(#${gradId})`;
  }
  return path;
}

/**
 * Fixed node dimensions — must match CSS --ca-node-size.
 * @shared-with-css: styles/_tokens.css
 */
export const NODE_W = 100;
export const NODE_H = 100;

// ---------------------------------------------------------------------------
// Pure geometry helpers
// ---------------------------------------------------------------------------

/**
 * Returns the cubic Bézier control point offset for a given anchor side.
 * The control point is displaced outward from the anchor in its natural exit direction.
 *
 * @param {string} side     — "top" | "right" | "bottom" | "left"
 * @param {number} tension  — pixel distance of the control point from the anchor (default 80)
 * @returns {{ dx: number, dy: number }}
 */
export function bezierOffset(side, tension = 80) {
  switch (side) {
    case "top":      return { dx:  0,       dy: -tension };
    case "right":    return { dx:  tension, dy:  0       };
    case "bottom":   return { dx:  0,       dy:  tension };
    case "left":     return { dx: -tension, dy:  0       };
    case "peek-tl":  return { dx: -tension, dy: -tension };
    case "peek-tr":  return { dx:  tension, dy: -tension };
    case "peek-bl":  return { dx: -tension, dy:  tension };
    case "peek-br":  return { dx:  tension, dy:  tension };
    default:         return { dx:  tension, dy:  0       };
  }
}

/**
 * Returns the canvas-space center of a named anchor dot on a node.
 * Reads live DOM position so it stays accurate during drags.
 * The zoom factor must be provided so screen coords are correctly converted to canvas coords
 * when the canvas has a CSS scale transform applied.
 * @param {HTMLElement} nodeEl — the .ca-node element
 * @param {string} side       — "top" | "right" | "bottom" | "left"
 * @param {DOMRect} wsRect    — workspace getBoundingClientRect()
 * @param {{ x: number, y: number }} pan — current pan offset
 * @param {number} zoom       — current zoom level (default 1)
 * @returns {{ x: number, y: number }}
 */
export function anchorPoint(nodeEl, side, wsRect, pan, zoom = 1) {
  const dot = nodeEl.querySelector(`.ca-anchor[data-anchor="${side}"]`);
  if (dot) {
    const r = dot.getBoundingClientRect();
    return {
      x: (r.left + r.width  / 2 - wsRect.left - pan.x) / zoom,
      y: (r.top  + r.height / 2 - wsRect.top  - pan.y) / zoom
    };
  }
  // Fallback when the anchor dot is not in the DOM
  const nx = parseFloat(nodeEl.style.left) || 0;
  const ny = parseFloat(nodeEl.style.top)  || 0;
  const offsets = {
    top:       { x: NODE_W / 2, y: 0          },
    right:     { x: NODE_W,     y: NODE_H / 2 },
    bottom:    { x: NODE_W / 2, y: NODE_H     },
    left:      { x: 0,          y: NODE_H / 2 },
    "peek-tl": { x: 0,          y: 0          },
    "peek-tr": { x: NODE_W,     y: 0          },
    "peek-bl": { x: 0,          y: NODE_H     },
    "peek-br": { x: NODE_W,     y: NODE_H     }
  };
  return { x: nx + (offsets[side]?.x ?? NODE_W / 2), y: ny + (offsets[side]?.y ?? 0) };
}

/**
 * Returns a point along a cubic Bézier curve at parameter t (0 = start, 1 = end) using
 * De Casteljau. Defaults to t=0.5, the midpoint, used for the primary direction glyph;
 * one-way block/lock combos also place a secondary indicator near t=0.2/0.8 — close to
 * whichever endpoint is on the closed side.
 * @param {{ x: number, y: number }} p1
 * @param {{ dx: number, dy: number }} c1
 * @param {{ x: number, y: number }} p2
 * @param {{ dx: number, dy: number }} c2
 * @param {number} [t=0.5]
 * @returns {{ x: number, y: number }}
 */
export function pathMidpoint(p1, c1, p2, c2, t = 0.5) {
  const cp1 = { x: p1.x + c1.dx, y: p1.y + c1.dy };
  const cp2 = { x: p2.x + c2.dx, y: p2.y + c2.dy };
  const x = Math.pow(1-t,3)*p1.x + 3*Math.pow(1-t,2)*t*cp1.x + 3*(1-t)*t*t*cp2.x + Math.pow(t,3)*p2.x;
  const y = Math.pow(1-t,3)*p1.y + 3*Math.pow(1-t,2)*t*cp1.y + 3*(1-t)*t*t*cp2.y + Math.pow(t,3)*p2.y;
  return { x, y };
}

/**
 * Returns the tangent angle (degrees) of a cubic Bézier at t=0.5.
 * Used to rotate the directional arrow so it aligns with the curve.
 * @param {{ x: number, y: number }} p1
 * @param {{ dx: number, dy: number }} c1
 * @param {{ x: number, y: number }} p2
 * @param {{ dx: number, dy: number }} c2
 * @returns {number}
 */
export function pathTangentAngle(p1, c1, p2, c2) {
  const cp1 = { x: p1.x + c1.dx, y: p1.y + c1.dy };
  const cp2 = { x: p2.x + c2.dx, y: p2.y + c2.dy };
  const t = 0.5;
  const dx = 3*Math.pow(1-t,2)*(cp1.x-p1.x) + 6*(1-t)*t*(cp2.x-cp1.x) + 3*t*t*(p2.x-cp2.x);
  const dy = 3*Math.pow(1-t,2)*(cp1.y-p1.y) + 6*(1-t)*t*(cp2.y-cp1.y) + 3*t*t*(p2.y-cp2.y);
  return Math.atan2(dy, dx) * (180 / Math.PI);
}

// ---------------------------------------------------------------------------
// SVG rendering
// ---------------------------------------------------------------------------

/**
 * Redraws all persistent SVG link lines from the current setting state.
 * Lines connect named anchor dots. Called from _onRender and after every graph mutation.
 * @param {ManagerApp} app
 */
export function renderLinks(app) {
  const workspace = app.element?.querySelector(".ca-workspace");
  if (!workspace) return;
  const svg = workspace.querySelector(".ca-links-layer");
  if (!svg) return;

  const { links } = getGraphData();

  // Remove only permanent links and direction indicators; leave the transient .ca-temp-link intact
  svg.querySelectorAll(".ca-link, .ca-link-hit, .ca-link-direction, .ca-link-direction-arrow").forEach(el => el.remove());

  // Gradient defs for one-way combo strokes (see _createLinkPath) — reused across renders,
  // cleared each time so stale gradients from removed/changed links don't pile up.
  let defs = svg.querySelector("defs.ca-link-defs");
  if (!defs) {
    defs = document.createElementNS(SVG_NS, "defs");
    defs.classList.add("ca-link-defs");
    svg.appendChild(defs);
  } else {
    defs.replaceChildren();
  }

  const wsRect = workspace.getBoundingClientRect();
  const zoom = app._zoom ?? 1;
  // Spacing between a multi-passage link's stacked per-passage lines — equal to their
  // stroke-width (links.css) so adjacent lines touch with no visible gap.
  const MULTI_LINE_GAP = 3;

  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const srcEl = workspace.querySelector(`[data-node-id="${link.sourceId}"]`);
    const tgtEl = workspace.querySelector(`[data-node-id="${link.targetId}"]`);
    if (!srcEl || !tgtEl) continue;

    const sourceAnchor = link.sourceAnchor ?? "right";
    const targetAnchor = link.targetAnchor ?? "left";
    const p1 = anchorPoint(srcEl, sourceAnchor, wsRect, app._pan, zoom);
    const p2 = anchorPoint(tgtEl, targetAnchor, wsRect, app._pan, zoom);
    const c1 = bezierOffset(sourceAnchor);
    const c2 = bezierOffset(targetAnchor);
    // Cubic Bézier: M start C cp1 cp2 end
    const d = `M ${p1.x},${p1.y} C ${p1.x + c1.dx},${p1.y + c1.dy} ${p2.x + c2.dx},${p2.y + c2.dy} ${p2.x},${p2.y}`;

    const isPeek = link.type === "peek";
    const multi = !isPeek && isMultiPassage(link);
    const passage0 = link.passages?.[0] ?? {};
    const direction = isPeek ? "peek" : multi ? null : _composeDirectionForRender(
      passage0.direction ?? "both",
      passage0.state ?? "open"
    );

    // Visible path(s) — pointer events disabled so the hit area path on top handles interactions.
    // Single-passage links draw one path (gradiented green→state-color when it's a one-way
    // combo, via _createLinkPath). Multi-passage links draw one thin dotted path per passage,
    // translated by a tight perpendicular offset so they stack into a contiguous bundle — a
    // uniform translation of both endpoints keeps each stacked curve exactly parallel to the
    // others since the control-point deltas (c1/c2) stay the same.
    const linkPaths = [];
    if (isPeek) {
      const path = document.createElementNS(SVG_NS, "path");
      path.classList.add("ca-link", "ca-link--peek");
      path.setAttribute("d", d);
      path.dataset.direction = "peek";
      path.style.pointerEvents = "none";
      svg.appendChild(path);
      linkPaths.push(path);
    } else if (multi) {
      const passages = link.passages;
      const n = passages.length;
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len; // unit vector perpendicular to the p1→p2 chord
      passages.forEach((passage, k) => {
        const off = (k - (n - 1) / 2) * MULTI_LINE_GAP;
        const sp1 = { x: p1.x + nx * off, y: p1.y + ny * off };
        const sp2 = { x: p2.x + nx * off, y: p2.y + ny * off };
        const pDirection = _composeDirectionForRender(passage.direction ?? "both", passage.state ?? "open");
        const path = _createLinkPath(defs, `${i}-${k}`, sp1, c1, sp2, c2, pDirection);
        path.dataset.multi = "true";
        svg.appendChild(path);
        linkPaths.push(path);
      });
    } else {
      const path = _createLinkPath(defs, String(i), p1, c1, p2, c2, direction);
      svg.appendChild(path);
      linkPaths.push(path);
    }

    // Invisible wide hit-area path — easy right-click target, toggles hover state on the visible path(s)
    const hitPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    hitPath.classList.add("ca-link-hit");
    hitPath.setAttribute("d", d);
    hitPath.dataset.linkIndex = String(i);
    hitPath.style.pointerEvents = "visibleStroke";
    hitPath.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      // Peek links don't cycle and don't open the passage editor
      if (isPeek) return;
      // Shift+click or multi-passage link → open editor.
      // Plain click on single-passage → cycle direction (both/forward/backward).
      // Ctrl/Cmd+click on single-passage → cycle state (open/blocked/secret/custom).
      if (e.shiftKey || multi) {
        new LinkEditorApp(i).render(true);
      } else if (e.ctrlKey || e.metaKey) {
        onCycleLinkState(app, i);
      } else {
        onCycleLink(app, i);
      }
    });
    hitPath.addEventListener("contextmenu", e => {
      e.preventDefault();
      e.stopPropagation();
      onDeleteLink(app, e, hitPath);
    });
    hitPath.addEventListener("mouseenter", () => linkPaths.forEach(p => p.classList.add("ca-link--hover")));
    hitPath.addEventListener("mouseleave", () => linkPaths.forEach(p => p.classList.remove("ca-link--hover")));
    svg.appendChild(hitPath);

    // Midpoint indicator
    const mid = pathMidpoint(p1, c1, p2, c2);

    if (isPeek) {
      // Eye icon to distinguish peek links from navigation links
      const indicator = document.createElementNS("http://www.w3.org/2000/svg", "text");
      indicator.classList.add("ca-link-direction");
      indicator.setAttribute("x", mid.x);
      indicator.setAttribute("y", mid.y);
      indicator.setAttribute("text-anchor", "middle");
      indicator.setAttribute("dominant-baseline", "central");
      indicator.dataset.direction = "peek";
      indicator.style.pointerEvents = "none";
      indicator.textContent = "👁";
      svg.appendChild(indicator);
    } else if (multi) {
      // No midpoint glyph needed — the stacked dotted lines themselves already read as
      // "multi-passage bundle," each colored/gradiented by its own passage's state.
    } else if (decomposeDirection(direction).dirAxis === "both") {
      const { stateAxis } = decomposeDirection(direction);
      const indicator = document.createElementNS("http://www.w3.org/2000/svg", "text");
      indicator.classList.add("ca-link-direction");
      indicator.setAttribute("x", mid.x);
      indicator.setAttribute("y", mid.y);
      indicator.setAttribute("text-anchor", "middle");
      indicator.setAttribute("dominant-baseline", "central");
      indicator.dataset.direction = stateAxis === "open" ? "both" : stateAxis;
      indicator.style.pointerEvents = "none";
      indicator.textContent = stateAxis === "open" ? "⟷" : _stateGlyph(stateAxis);
      svg.appendChild(indicator);
    } else {
      const oneWay = splitOneWayState(direction);
      // Arrowhead aligned with the curve tangent at t=0.5, pointing along the open side
      // (the combo's own open side for a one-way block/lock combo, otherwise `direction` itself).
      const openSide = oneWay?.openSide ?? direction;
      const angle = pathTangentAngle(p1, c1, p2, c2);
      const arrowAngle = openSide === "forward" ? angle : angle + 180;
      const arrow = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      arrow.classList.add("ca-link-direction-arrow");
      arrow.dataset.direction = openSide;
      // Tip at (8,0), base corners at (-6,-5) and (-6,5) — points right by default
      arrow.setAttribute("points", "8,0 -6,-5 -6,5");
      arrow.setAttribute("transform", `translate(${mid.x}, ${mid.y}) rotate(${arrowAngle})`);
      arrow.style.pointerEvents = "none";
      svg.appendChild(arrow);

      if (oneWay) {
        // Secondary glyph near the closed side's own endpoint (t=0.2 for a closed source,
        // t=0.8 for a closed target) so the GM can see at a glance which side is restricted.
        const closedT = oneWay.openSide === "forward" ? 0.8 : 0.2;
        const closedPoint = pathMidpoint(p1, c1, p2, c2, closedT);
        const closedIndicator = document.createElementNS("http://www.w3.org/2000/svg", "text");
        closedIndicator.classList.add("ca-link-direction", "ca-link-direction--secondary");
        closedIndicator.setAttribute("x", closedPoint.x);
        closedIndicator.setAttribute("y", closedPoint.y);
        closedIndicator.setAttribute("text-anchor", "middle");
        closedIndicator.setAttribute("dominant-baseline", "central");
        closedIndicator.dataset.direction = oneWay.closedState;
        closedIndicator.style.pointerEvents = "none";
        closedIndicator.textContent = _stateGlyph(oneWay.closedState);
        svg.appendChild(closedIndicator);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Link mutation handlers (kept here because they trigger renderLinks)
// ---------------------------------------------------------------------------

/**
 * Cycles one field (direction or state) on a single-passage link and persists the result.
 * Shared by onCycleLink (direction) and onCycleLinkState (state).
 * @param {ManagerApp} app
 * @param {number} linkIndex
 * @param {"direction"|"state"} field
 * @param {(current: string) => string} cycleFn
 * @returns {Promise<string|null>} the field's new value, or null if it was a no-op
 *   (peek link, or multi-passage — edited via LinkEditorApp instead)
 */
async function _mutatePassageField(app, linkIndex, field, cycleFn) {
  const { sceneId, startNodeId, nodes, links } = getGraphData();
  let result = null;
  const fallback = field === "direction" ? "both" : "open";
  const updatedLinks = links.map((l, i) => {
    if (i !== linkIndex) return l;
    if (l.type === "peek") return l;
    // Multi-passage links are edited via LinkEditorApp — cycling is a no-op here
    if (isMultiPassage(l)) return l;
    const passage0 = l.passages?.[0] ?? { label: "", direction: "both", state: "open" };
    const next = cycleFn(passage0[field] ?? fallback);
    result = next;
    return { ...l, passages: [{ ...passage0, [field]: next }] };
  });
  await saveGraphData({ sceneId, startNodeId, nodes, links: updatedLinks });
  // Full re-render, not just renderLinks: cycling direction/state can add or remove a
  // node's last player-viable exit, and the "no way out" red outline (nodeHasNoPlayerExit,
  // computed in _prepareContext) needs to reflect that immediately, not just on the next
  // unrelated render.
  app.render({ force: true });

  // Notify HUD immediately so destination list reflects the new link state
  const hud = globalThis.ClickAdventure._hud;
  if (hud?.rendered) hud.render({ force: true });

  return result;
}

/**
 * Cycles the passage's direction: both → forward → backward → both.
 * Triggered by a plain click on a .ca-link-hit element.
 * @param {ManagerApp} app
 * @param {number} linkIndex
 * @returns {Promise<void>}
 */
export async function onCycleLink(app, linkIndex) {
  await _mutatePassageField(app, linkIndex, "direction", cyclePassageDirection);
}

/**
 * Cycles the passage's state: open → blocked → secret → custom → open.
 * Triggered by a Ctrl/Cmd+click on a .ca-link-hit element. Landing on "custom" opens the
 * Passage Editor immediately, since that's the only place a passage's keys can be
 * configured — canvas clicking alone can't drag a key onto it.
 * @param {ManagerApp} app
 * @param {number} linkIndex
 * @returns {Promise<void>}
 */
export async function onCycleLinkState(app, linkIndex) {
  const newState = await _mutatePassageField(app, linkIndex, "state", cyclePassageState);
  if (newState === "custom") new LinkEditorApp(linkIndex).render(true);
}

/**
 * Deletes a link after a right-click contextmenu event on its SVG line.
 * Uses a native Foundry DialogV2 confirmation to avoid accidental deletion.
 * @param {ManagerApp} app
 * @param {MouseEvent} e
 * @param {SVGPathElement} lineEl
 * @returns {Promise<void>}
 */
export async function onDeleteLink(app, e, lineEl) {
  const linkIndex = parseInt(lineEl.dataset.linkIndex, 10);

  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Delete Link" },
    classes: ["click-adventure", "ca-dialog"],
    content: "<p>Remove this connection?</p>",
    yes: { class: "ca-btn ca-btn--danger" },
    no:  { class: "ca-btn ca-btn--quiet" },
    rejectClose: false
  });
  if (!confirmed) return;

  // Re-fetch after dialog closes — user may have taken time to confirm
  const freshGraph = getGraphData();
  const filtered = freshGraph.links.filter((_, idx) => idx !== linkIndex);
  await saveGraphData({ links: filtered });
  app.render({ force: true });
}
