/**
 * Main node-graph window for the Click Adventure module.
 * Displays an interactive workspace where the user places scene nodes and draws links between them.
 *
 * This file is a thin shell: it handles ApplicationV2 lifecycle, wires event listeners,
 * and delegates all domain logic to four extracted modules:
 *  - manager-graph.js        — SVG link rendering, Bézier geometry
 *  - manager-interaction.js  — Node drag, link-draw, pan
 *  - manager-players.js      — Occupant display, teleport, navigation requests
 *  - manager-scene-ops.js    — Node creation, folder import, scene sync, reset
 *
 * SVG link layer is redrawn after every mutation via renderLinks().
 * Lifecycle hook: renderManagerApp
 */

import { InstructionsApp } from "./instructions-app.js";
import { SettingsApp } from "./settings-app.js";
import { getNodeActiveImage, getGraphData, saveGraphData, isMultiPassage, getPassageStateFromSide, nodeHasNoPlayerExit } from "./node-utils.js";

const _VIDEO_EXT = new Set(["webm", "mp4"]);
/** @param {string} src @returns {boolean} */
function isVideoSrc(src) {
  return _VIDEO_EXT.has(src?.split(".").pop()?.toLowerCase() ?? "");
}

import { renderLinks } from "./manager-graph.js";
import {
  CANVAS_SIZE,
  onNodeMouseDown, onAnchorMouseDown, onNodeDblClick,
  onDocMouseMove, onDocMouseUp,
  onWorkspaceWheel, onZoomReset, onZoomAll,
  clearSelection
} from "./manager-interaction.js";
import {
  buildOccupants, buildPlayerPanelData, patchOccupantAvatars, patchRequestsDrawer,
  approveRequest, onApproveAll, rejectRequest,
  onNodeContextMenu,
  lockAllPlayers, unlockAllPlayers, onResetVisitedScenes
} from "./manager-players.js";
import {
  onAddNode, onImportFolder, onSyncScenes, onResetMacros,
  onViewScene, onActivateScene
} from "./manager-scene-ops.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ManagerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @override */
  static BASE_APPLICATION = ApplicationV2;

  /** @override */
  static DEFAULT_OPTIONS = {
    id: "manager-app",
    classes: ["click-adventure", "manager"],
    window: { title: "Click Adventure — Scene Graph", resizable: true },
    position: { width: 900, height: 620 }
  };

  /** @override */
  static PARTS = {
    workspace: {
      template: "modules/click-adventure/templates/manager-app.hbs"
    }
  };

  constructor(options = {}) {
    super(options);
    /**
     * Active drag operation state.
     * @type {{ nodeId: string, nodeEl: HTMLElement, offsetX: number, offsetY: number }|null}
     */
    this._dragState = null;
    /**
     * Active link-draw operation state.
     * @type {{ sourceId: string, sourceAnchor: string, startX: number, startY: number, tempLine: SVGPathElement }|null}
     */
    this._linkState = null;

    // Bound versions kept so document listeners can be removed on close.
    this._docMouseMove = (e) => onDocMouseMove(this, e);
    this._docMouseUp   = (e) => onDocMouseUp(this, e);

    /** @type {InstructionsApp|null} — active instructions popover instance. */
    this._instructionsApp = null;

    /** @type {SettingsApp|null} — active settings popover instance. */
    this._settingsApp = null;

    /**
     * Pending navigation requests from non-GM players.
     * Map<userId, { userId, userName, userColor, fromNodeId, toNodeId, timestamp }>
     * One entry per user — a new request from the same user overwrites the old one.
     * @type {Map<string, object>}
     */
    this._navRequests = new Map();

    /** @type {boolean} — tracks drawer open state across renders. */
    this._drawerOpen = false;

    /**
     * Foundry hook ID for the "updateUser" hook, registered while the app is open.
     * Stored so the hook can be removed without stacking duplicates on re-renders.
     * @type {number|undefined}
     */
    this._onUpdateUserHook = undefined;

    /**
     * Foundry hook ID for the "userConnected" hook, registered while the app is open.
     * Fires when any user connects or disconnects, allowing the player panel to reflect
     * online/offline status without requiring the manager to be closed and reopened.
     * @type {number|undefined}
     */
    this._onUserConnectedHook = undefined;

    /**
     * Current pan offset and zoom level of the canvas.
     * Persisted together in the "managerPan" client setting.
     * @type {{ x: number, y: number }}
     */
    // Restore pan and zoom from client setting so position survives close/reopen
    const savedPan = game.settings.get("click-adventure", "managerPan");
    this._pan  = { x: savedPan?.x ?? 0, y: savedPan?.y ?? 0 };
    /** @type {number} — current zoom level; clamped to [0.5, 1.5] by wheel handler. */
    this._zoom = savedPan?.zoom ?? 1;

    /**
     * Active pan drag state.
     * @type {{ startX: number, startY: number, originX: number, originY: number }|null}
     */
    this._panState = null;

    /**
     * Active rubber-band selection state.
     * Set on left-click drag on the canvas background; cleared in onDocMouseUp.
     * @type {{ startClientX: number, startClientY: number, rectEl: HTMLElement|null, active: boolean }|null}
     */
    this._selectState = null;

    /**
     * Set of node IDs currently selected for group move.
     * @type {Set<string>}
     */
    this._selectedNodes = new Set();
  }

  // ---------------------------------------------------------------------------
  // Public API — delegates to extracted modules
  // ---------------------------------------------------------------------------

  /** @see buildOccupants in manager-players.js */
  _buildOccupants() { return buildOccupants(); }

  /** @see patchOccupantAvatars in manager-players.js */
  _patchOccupantAvatars() { patchOccupantAvatars(this); }

  /** @see patchRequestsDrawer in manager-players.js */
  _patchRequestsDrawer() { patchRequestsDrawer(this); }

  /**
   * Launches a Visual Polls navigation vote for all online non-GM players.
   * Builds the option list from the navigable links on the GM's current node,
   * using the same direction rules as the player HUD (blocked and locked excluded).
   * No-ops if visual-polls is not active or the GM has no current node set.
   * @returns {Promise<void>}
   */
  async _launchNavigationPoll() {
    if (!globalThis.VisualPolls) {
      ui.notifications.warn("Click Adventure: visual-polls module is not available.");
      return;
    }

    const gmNodeId = game.user.getFlag("click-adventure", "currentNodeId");
    if (!gmNodeId) {
      ui.notifications.warn("Click Adventure: Set your current node position first.");
      return;
    }

    const { nodes, links } = getGraphData();
    const gmNode = nodes.find(n => n.id === gmNodeId);
    if (!gmNode) {
      ui.notifications.warn("Click Adventure: Current node not found in graph.");
      return;
    }

    const seen = new Set();
    const options = [];

    for (const link of links) {
      // Peek links are not navigation options
      if (link.type === "peek") continue;
      if (isMultiPassage(link)) {
        for (const passage of link.passages) {
          const side = link.sourceId === gmNodeId ? "source" : (link.targetId === gmNodeId ? "target" : null);
          if (!side || getPassageStateFromSide(passage, side) !== "open") continue;
          const otherId = side === "source" ? link.targetId : link.sourceId;
          const other = nodes.find(n => n.id === otherId);
          if (!other) continue;
          const navName = other.label || game.scenes.get(other.sceneId)?.name || other.id;
          const text = passage.label ? `${navName} (${passage.label})` : navName;
          const imgs = Array.isArray(other.images) ? other.images : [];
          const imgSrc = imgs[other.activeImageIndex ?? 0]?.src ?? null;
          const option = { text };
          if (imgSrc) option.image = imgSrc;
          options.push(option);
        }
      } else {
        const passage0 = link.passages?.[0] ?? {};
        const side = link.sourceId === gmNodeId ? "source" : (link.targetId === gmNodeId ? "target" : null);
        if (!side || getPassageStateFromSide(passage0, side) !== "open") continue;
        const otherId = side === "source" ? link.targetId : link.sourceId;
        if (seen.has(otherId)) continue;
        const other = nodes.find(n => n.id === otherId);
        if (!other) continue;
        seen.add(otherId);
        const text = other.label || game.scenes.get(other.sceneId)?.name || other.id;
        const imgs = Array.isArray(other.images) ? other.images : [];
        const imgSrc = imgs[other.activeImageIndex ?? 0]?.src ?? null;
        const option = { text };
        if (imgSrc) option.image = imgSrc;
        options.push(option);
      }
    }

    if (options.length < 2) {
      ui.notifications.warn("Click Adventure: At least 2 navigable destinations are needed to create a poll.");
      return;
    }

    const targetUserIds = game.users
      .filter(u => !u.isGM && u.active)
      .map(u => u.id);

    const nodeLabel = gmNode.label || gmNodeId;
    await globalThis.VisualPolls.startPoll({
      question: `[${nodeLabel}] Where does the group want to go?`,
      options,
      targetUserIds
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Provides graph nodes and links to the workspace template.
   * Triggered during the ApplicationV2 _prepareContext lifecycle stage.
   *
   * @override
   * @param {object} options
   * @returns {Promise<object>}
   */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const { nodes, links, startNodeId } = getGraphData();
    const occupants = buildOccupants();
    const hasPeekAnchors = nodes.some(n => n.isCameraRoom);
    context.hasPeekAnchors = hasPeekAnchors;
    context.nodes = nodes.map(n => {
      const imageSrc = getNodeActiveImage(n);
      return {
        ...n,
        imageSrc,
        isVideo: isVideoSrc(imageSrc),
        occupants: occupants.get(n.id) ?? [],
        noExit: nodeHasNoPlayerExit(n.id, links)
      };
    });
    context.links = links;
    context.startNodeId = startNodeId ?? "";
    context.hasAnyScene = nodes.some(n => n.sceneId && game.scenes.get(n.sceneId));
    context.nodesWithoutScene = nodes.filter(n => !n.sceneId || !game.scenes.get(n.sceneId)).length;

    // Count once-macros that have already fired across all nodes
    context.resetMacrosCount = context.nodes.reduce((total, node) => {
      if (!Array.isArray(node.nodeMacros)) return total;
      return total + node.nodeMacros.filter(
        m => m.executeMode === "once" && m.executedOnce === true
      ).length;
    }, 0);

    const getLabel = id => nodes.find(n => n.id === id)?.label || id;
    context.navigationMode    = game.settings.get("click-adventure", "navigationMode");
    context.autolockDefault   = game.settings.get("click-adventure", "autolockDefault");
    context.visualPollsActive = game.modules.get("visual-polls")?.active ?? false;
    context.requestCount     = this._navRequests.size;
    context.drawerOpen     = this._drawerOpen;
    context.requests       = [...this._navRequests.values()]
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(r => ({ ...r, fromLabel: getLabel(r.fromNodeId), toLabel: getLabel(r.toNodeId) }));
    context.players = buildPlayerPanelData();

    return context;
  }

  /**
   * Attaches document-level mousemove/mouseup exactly once so drag and link-draw
   * work even when the pointer leaves the workspace element.
   * Triggered during the ApplicationV2 _onFirstRender lifecycle stage.
   *
   * @override
   * @param {object} context
   * @param {object} options
   */
  _onFirstRender(context, options) {
    super._onFirstRender(context, options);
    document.addEventListener("mousemove", this._docMouseMove);
    document.addEventListener("mouseup", this._docMouseUp);

    this._docKeyDown = (e) => {
      if (!this.rendered) return;
      if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
        // Only intercept if focus is inside the manager window or on body
        if (!this.element?.contains(document.activeElement) && document.activeElement !== document.body) return;
        e.preventDefault();
        e.stopPropagation();
        // Select all nodes
        this._selectedNodes.clear();
        this.element?.querySelectorAll(".ca-node").forEach(el => {
          this._selectedNodes.add(el.dataset.nodeId);
          el.classList.add("ca-node--selected");
        });
      }
    };
    document.addEventListener("keydown", this._docKeyDown);
  }

  /**
   * Redraws SVG links and wires all element-level listeners after every render.
   * HandlebarsApplicationMixin destroys and recreates part DOM on each render,
   * so there is no risk of duplicate listeners on the new elements.
   * Triggered during the ApplicationV2 _onRender lifecycle stage.
   *
   * @override
   * @param {object} context
   * @param {object} options
   */
  _onRender(context, options) {
    super._onRender(context, options);

    const html = this.element;

    html.querySelectorAll(".ca-node").forEach(nodeEl => {
      nodeEl.addEventListener("mousedown", e => onNodeMouseDown(this, e, nodeEl));
      nodeEl.addEventListener("dblclick", e => onNodeDblClick(this, e, nodeEl));
      nodeEl.addEventListener("contextmenu", e => {
        e.preventDefault();
        e.stopPropagation();
        onNodeContextMenu(this, e, nodeEl.dataset.nodeId);
      });
    });

    html.querySelectorAll(".ca-anchor").forEach(anchor => {
      anchor.addEventListener("mousedown", e => onAnchorMouseDown(this, e, anchor));
    });

    html.querySelectorAll(".ca-view-scene-btn").forEach(btn => {
      btn.addEventListener("mousedown", e => e.stopPropagation()); // prevents accidental drag start
      btn.addEventListener("click", e => {
        e.stopPropagation();
        onViewScene(this, btn.dataset.sceneId, btn.dataset.nodeId);
      });
    });

    html.querySelectorAll(".ca-activate-scene-btn").forEach(btn => {
      btn.addEventListener("mousedown", e => e.stopPropagation());
      btn.addEventListener("click", e => {
        e.stopPropagation();
        onActivateScene(this, btn.dataset.sceneId, btn.dataset.nodeId);
      });
    });


    html.querySelector(".ca-add-node")?.addEventListener("click", () => onAddNode(this));
    html.querySelector(".ca-import-folder")?.addEventListener("click", () => onImportFolder(this));
    html.querySelector(".ca-sync-scenes")?.addEventListener("click", () => onSyncScenes(this));

    // Reset dropdown — toggled open/closed, closes on any outside click. The
    // outside-click listener is only attached while open and removes itself,
    // so repeated renders never pile up document-level listeners.
    const resetMenu = html.querySelector(".ca-reset-menu");
    const closeResetMenu = e => {
      if (resetMenu.contains(e.target)) return;
      resetMenu.hidden = true;
      document.removeEventListener("mousedown", closeResetMenu);
    };
    html.querySelector(".ca-reset-menu-toggle")?.addEventListener("click", e => {
      e.stopPropagation();
      if (!resetMenu) return;
      resetMenu.hidden = !resetMenu.hidden;
      if (!resetMenu.hidden) {
        setTimeout(() => document.addEventListener("mousedown", closeResetMenu), 0);
      }
    });
    resetMenu?.querySelector(".ca-reset-macros")?.addEventListener("click", () => {
      resetMenu.hidden = true;
      onResetMacros(this);
    });
    resetMenu?.querySelector(".ca-reset-visited-scenes")?.addEventListener("click", () => {
      resetMenu.hidden = true;
      onResetVisitedScenes();
    });

    html.querySelector(".ca-autolock-toggle")?.addEventListener("click", async () => {
      const current = game.settings.get("click-adventure", "autolockDefault");
      await game.settings.set("click-adventure", "autolockDefault", !current);
      this.render({ force: true });
    });

    html.querySelector(".ca-free-move-toggle")?.addEventListener("click", async () => {
      const current = game.settings.get("click-adventure", "navigationMode");
      const next = current === "open" ? "gated" : "open";
      await game.settings.set("click-adventure", "navigationMode", next);
      this.render({ force: true });
    });

    html.querySelector(".ca-requests-btn")?.addEventListener("click", () => {
      this._drawerOpen = !this._drawerOpen;
      const drawer = html.querySelector(".ca-requests-drawer");
      drawer?.classList.toggle("ca-requests-drawer--open", this._drawerOpen);
    });

    html.querySelector(".ca-approve-all-btn")?.addEventListener("click", () => onApproveAll(this));

    html.querySelectorAll(".ca-request-approve").forEach(btn => {
      btn.addEventListener("click", () => approveRequest(this, btn.dataset.userId, btn.dataset.nodeId));
    });

    html.querySelectorAll(".ca-request-reject").forEach(btn => {
      btn.addEventListener("click", () => rejectRequest(this, btn.dataset.userId));
    });

    const instrBtn = html.querySelector(".ca-instructions-btn");
    if (instrBtn) {
      instrBtn.addEventListener("click", () => {
        if (this._instructionsApp?.rendered) {
          this._instructionsApp.close();
          this._instructionsApp = null;
          return;
        }
        this._instructionsApp = new InstructionsApp();
        this._instructionsApp.render(true);
      });
    }

    const gearBtn = html.querySelector(".ca-settings-btn");
    if (gearBtn) {
      gearBtn.addEventListener("click", () => {
        if (this._settingsApp?.rendered) {
          this._settingsApp.close();
          this._settingsApp = null;
          return;
        }
        this._settingsApp = new SettingsApp();
        this._settingsApp.render(true);
      });
    }

    // Apply saved pan + zoom to canvas
    const canvas = html.querySelector(".ca-canvas");
    if (canvas) {
      canvas.style.transform = `translate(${this._pan.x}px, ${this._pan.y}px) scale(${this._zoom})`;
    }

    renderLinks(this);

    // Re-apply selection classes — Handlebars destroys and recreates DOM on each render.
    this._selectedNodes.forEach(id => {
      const el = this.element?.querySelector(`.ca-node[data-node-id="${id}"]`);
      el?.classList.add("ca-node--selected");
    });

    // React to flag changes set by a player's own ready hook (e.g. first join).
    // Guard against duplicate registrations on repeated renders.
    if (this._onUpdateUserHook !== undefined) {
      Hooks.off("updateUser", this._onUpdateUserHook);
    }
    this._onUpdateUserHook = Hooks.on("updateUser", (user, diff) => {
      if (diff.flags?.["click-adventure"]?.currentNodeId === undefined) return;
      patchOccupantAvatars(this);
    });

    // Reflect user connection/disconnection in the player panel without reopening the manager.
    if (this._onUserConnectedHook !== undefined) {
      Hooks.off("userConnected", this._onUserConnectedHook);
    }
    this._onUserConnectedHook = Hooks.on("userConnected", () => {
      patchOccupantAvatars(this);
    });

    // Bidirectional highlight: hovering a node highlights the panel row.
    html.querySelectorAll(".ca-node").forEach(nodeEl => {
      const nodeId = nodeEl.dataset.nodeId;
      nodeEl.addEventListener("mouseenter", () => {
        html.querySelectorAll(`.ca-player-row[data-node-id="${nodeId}"]`)
          .forEach(row => row.classList.add("ca-player-row--highlighted"));
      });
      nodeEl.addEventListener("mouseleave", () => {
        html.querySelectorAll(`.ca-player-row[data-node-id="${nodeId}"]`)
          .forEach(row => row.classList.remove("ca-player-row--highlighted"));
      });
    });

    // Pan (right-click) and rubber-band selection (left-click drag) on the workspace background.
    // Node mousedown calls stopPropagation, so this never fires for node clicks.
    // The SVG links layer is also included in the background check since empty SVG area
    // may retain pointer events depending on the browser's hit-testing.
    const workspace = html.querySelector(".ca-workspace");
    if (workspace) {
      workspace.addEventListener("mousedown", e => {
        const onBackground = e.target === workspace
          || e.target.classList.contains("ca-canvas")
          || e.target.classList.contains("ca-links-layer");
        if (!onBackground) return;

        if (e.button === 2) {
          // Right-click → pan
          e.preventDefault();
          this._panState = {
            startX: e.clientX,
            startY: e.clientY,
            originX: this._pan.x,
            originY: this._pan.y
          };
        } else if (e.button === 0) {
          // Left-click → begin rubber-band; activated after the 5 px drag threshold.
          // Clear-selection (pure click, no drag) is handled in onDocMouseUp.
          e.preventDefault();
          this._selectState = {
            startClientX: e.clientX,
            startClientY: e.clientY,
            rectEl: null,
            active: false
          };
        }
      });

      // Suppress the native browser context menu on the canvas background so
      // right-drag pan works cleanly. Node contextmenu listeners call
      // stopPropagation, so they are unaffected.
      workspace.addEventListener("contextmenu", e => {
        if (e.target === workspace || e.target.classList.contains("ca-canvas")) {
          e.preventDefault();
        }
      });

      // Zoom toward cursor on wheel; { passive: false } required to call preventDefault.
      workspace.addEventListener("wheel", e => onWorkspaceWheel(e, this), { passive: false });
    }

    html.querySelector(".ca-poll-btn")?.addEventListener("click", () => this._launchNavigationPoll());

    html.querySelector(".ca-zoom-reset")?.addEventListener("click", () => onZoomReset(this));
    html.querySelector(".ca-zoom-all")?.addEventListener("click", () => onZoomAll(this));

    // Bulk lock/unlock buttons in the Players panel header (rendered once by HBS)
    html.querySelector(".ca-bulk-lock-btn[data-action='lock-all']")
      ?.addEventListener("click", () => lockAllPlayers(this));
    html.querySelector(".ca-bulk-lock-btn[data-action='unlock-all']")
      ?.addEventListener("click", () => unlockAllPlayers(this));

    // Ensure player panel rows have click/hover listeners immediately after
    // every render, including the initial Handlebars render.
    patchOccupantAvatars(this);
  }

  /**
   * Removes document-level listeners to prevent leaks after the window is closed.
   * Triggered during the ApplicationV2 _onClose lifecycle stage.
   *
   * @override
   * @param {object} options
   * @returns {Promise<void>}
   */
  async _onClose(options) {
    document.removeEventListener("mousemove", this._docMouseMove);
    document.removeEventListener("mouseup", this._docMouseUp);
    document.removeEventListener("keydown", this._docKeyDown);
    this._dragState   = null;
    this._linkState   = null;
    this._selectState = null;
    this._instructionsApp?.close();
    this._instructionsApp = null;
    this._settingsApp?.close();
    this._settingsApp = null;
    document.querySelector(".ca-context-menu")?.remove();
    if (this._onUpdateUserHook !== undefined) {
      Hooks.off("updateUser", this._onUpdateUserHook);
      this._onUpdateUserHook = undefined;
    }
    if (this._onUserConnectedHook !== undefined) {
      Hooks.off("userConnected", this._onUserConnectedHook);
      this._onUserConnectedHook = undefined;
    }
    globalThis.ClickAdventure._manager = null;
    await super._onClose(options);
  }
}
