/**
 * SVG link rendering and Bézier geometry for the Manager workspace.
 * Extracted from ManagerApp to keep the main shell small.
 *
 * Every function receives the ManagerApp instance as `app` so it can
 * access `app.element`, `app._pan`, and sibling methods via delegation.
 */

import { LinkEditorApp } from "./link-editor-app.js";
import { getGraphData, saveGraphData, isMultiPassage, getEffectiveDirection, decomposeDirection, cycleLinkDirectionAxis, cycleLinkStateAxis, splitOneWayState } from "./node-utils.js";

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

  const wsRect = workspace.getBoundingClientRect();
  const zoom = app._zoom ?? 1;

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

    // Visible path — pointer events disabled so the hit area path on top handles interactions
    const isPeek = link.type === "peek";
    const direction = isPeek ? "peek" : getEffectiveDirection(link);
    const multi = !isPeek && isMultiPassage(link);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.classList.add("ca-link");
    if (isPeek) path.classList.add("ca-link--peek");
    path.setAttribute("d", d);
    path.dataset.direction = direction;
    if (multi) path.dataset.multi = "true";
    path.style.pointerEvents = "none";
    svg.appendChild(path);

    // Invisible wide hit-area path — easy right-click target, toggles hover state on the visible path
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
      // Ctrl/Cmd+click on single-passage → cycle state (open/blocked/locked).
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
    hitPath.addEventListener("mouseenter", () => path.classList.add("ca-link--hover"));
    hitPath.addEventListener("mouseleave", () => path.classList.remove("ca-link--hover"));
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
      const indicator = document.createElementNS("http://www.w3.org/2000/svg", "text");
      indicator.classList.add("ca-link-direction");
      indicator.setAttribute("x", mid.x);
      indicator.setAttribute("y", mid.y);
      indicator.setAttribute("text-anchor", "middle");
      indicator.setAttribute("dominant-baseline", "central");
      indicator.dataset.direction = "multi";
      indicator.style.pointerEvents = "none";
      indicator.textContent = "⊕";
      svg.appendChild(indicator);
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
 * Applies a direction-mutating function to a single-passage link and persists the result.
 * Shared by onCycleLink and onCycleLinkState — both are a "read current direction, compute
 * the next one, write it back" operation that only differs in which axis it cycles.
 * @param {ManagerApp} app
 * @param {number} linkIndex
 * @param {(currentDir: string) => string} nextDirection
 * @returns {Promise<string|null>} the link's new direction, or null if it was a no-op
 *   (peek link, or multi-passage — cycled via LinkEditorApp instead)
 */
async function _mutateLinkDirection(app, linkIndex, nextDirection) {
  const { sceneId, startNodeId, nodes, links } = getGraphData();
  let result = null;
  const updatedLinks = links.map((l, i) => {
    if (i !== linkIndex) return l;
    // Peek links have no direction — cycling is a no-op
    if (l.type === "peek") return l;
    // Multi-passage links are edited via LinkEditorApp — cycling is a no-op here
    if (isMultiPassage(l)) return l;
    const currentDir = l.passages?.[0]?.direction ?? l.direction ?? "both";
    const newDir = nextDirection(currentDir);
    result = newDir;
    const updatedPassages = l.passages
      ? [{ ...l.passages[0], direction: newDir }]
      : [{ label: "", direction: newDir }];
    return { ...l, passages: updatedPassages };
  });
  await saveGraphData({ sceneId, startNodeId, nodes, links: updatedLinks });
  renderLinks(app);

  // Notify HUD immediately so destination list reflects the new link state
  const hud = globalThis.ClickAdventure._hud;
  if (hud?.rendered) hud.render({ force: true });

  return result;
}

/**
 * Cycles a link's direction axis: both → forward → backward → both. The state axis
 * (open/blocked/locked) is preserved. Triggered by a plain click on a .ca-link-hit element.
 * @param {ManagerApp} app
 * @param {number} linkIndex
 * @returns {Promise<void>}
 */
export async function onCycleLink(app, linkIndex) {
  await _mutateLinkDirection(app, linkIndex, cycleLinkDirectionAxis);
}

/**
 * Cycles a link's state axis: open → blocked → secret → custom → open. The direction axis
 * (both/forward/backward) is preserved. Triggered by a Ctrl/Cmd+click on a .ca-link-hit
 * element. Landing on "custom" opens the Passage Editor immediately, since that's the only
 * place a passage's keys can be configured — canvas clicking alone can't drag a key onto it.
 * @param {ManagerApp} app
 * @param {number} linkIndex
 * @returns {Promise<void>}
 */
export async function onCycleLinkState(app, linkIndex) {
  const newDirection = await _mutateLinkDirection(app, linkIndex, cycleLinkStateAxis);
  if (newDirection && decomposeDirection(newDirection).stateAxis === "custom") {
    new LinkEditorApp(linkIndex).render(true);
  }
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
