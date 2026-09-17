/**
 * Editor sheet for the passages array of a link.
 *
 * A link with exactly one passage behaves identically to the legacy direction-cycling link.
 * A link with 2+ passages is "multi-passage" — clicking it in the Manager opens this sheet
 * instead of cycling direction.  Shift+click opens this sheet regardless of passage count.
 *
 * Opened from ManagerApp._renderLinks via Shift+click or auto-open for multi-passage links.
 * Lifecycle hook: renderLinkEditorApp
 */

import { getEffectiveDirection, getGraphData, saveGraphData, decomposeDirection, cycleLinkDirectionAxis, cycleLinkStateAxis } from "./node-utils.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class LinkEditorApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @override */
  static BASE_APPLICATION = ApplicationV2;

  /** @override */
  static DEFAULT_OPTIONS = {
    id: "link-editor-app",
    classes: ["click-adventure", "link-editor"],
    window: { title: "Edit Link Passages", resizable: false },
    position: { width: 560, height: "auto" }
  };

  /** @override */
  static PARTS = {
    editor: { template: "modules/click-adventure/templates/link-editor-app.hbs" }
  };

  /**
   * @param {number} linkIndex — index into the graph.links array
   * @param {object} [options]
   */
  constructor(linkIndex, options = {}) {
    super(options);
    /** @type {number} */
    this._linkIndex = linkIndex;
    /**
     * Mutable working copy of passages — initialised from persisted data on first _prepareContext,
     * then updated in-memory until Save is clicked.  Mirrors NodeConfigApp's pending-state pattern.
     * @type {Array<{label: string, direction: string}>|null}
     */
    this._pendingPassages = null;
  }



  /**
   * Provides passage rows and endpoint labels to the editor template.
   * Pending passages are seeded from the persisted link only on the very first call so that
   * in-progress edits survive re-renders triggered by Add / Remove / direction-cycle.
   * Triggered during the ApplicationV2 _prepareContext lifecycle stage.
   *
   * @override
   * @param {object} options
   * @returns {Promise<object>}
   */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const { nodes, links } = getGraphData();
    const link = links[this._linkIndex];

    if (!link) {
      // Link was deleted while this sheet was open — close gracefully
      await this.close();
      return context;
    }

    if (!this._pendingPassages) {
      const stored = link.passages ?? [{ label: "", direction: getEffectiveDirection(link) }];
      this._pendingPassages = structuredClone(stored);
    }

    const srcNode = nodes.find(n => n.id === link.sourceId);
    const tgtNode = nodes.find(n => n.id === link.targetId);
    context.fromLabel  = srcNode?.label || link.sourceId;
    context.toLabel    = tgtNode?.label || link.targetId;
    // Inject numeric index, per-passage display mode flag, and the direction/state axes
    // (the two independent controls the row renders) for the template
    context.passages = this._pendingPassages.map((p, i) => {
      const { dirAxis, stateAxis } = decomposeDirection(p.direction ?? "both");
      return {
        ...p,
        index: i,
        displayModeIsPathOnly: (p.displayMode ?? "full") === "path-only",
        dirAxis,
        stateAxis
      };
    });
    // True when the link is already promoted to multi-passage (either by forceMulti or 2+ passages)
    context.isMulti = link.forceMulti === true || (link.passages?.length ?? 0) > 1;
    return context;
  }

  /**
   * Wires all passage-row interactions after every render.
   * Triggered during the ApplicationV2 _onRender lifecycle stage.
   *
   * @override
   * @param {object} context
   * @param {object} options
   */
  _onRender(context, options) {
    super._onRender(context, options);
    const html = this.element;

    html.querySelector(".ca-passage-add")?.addEventListener("click", () => {
      this._pendingPassages.push({ label: "", direction: "both" });
      this.render({ force: true });
    });

    html.querySelectorAll(".ca-passage-remove").forEach(btn => {
      btn.addEventListener("click", () => {
        const i = parseInt(btn.closest("[data-index]").dataset.index, 10);
        this._pendingPassages.splice(i, 1);
        // Always keep at least one passage row
        if (this._pendingPassages.length === 0) {
          this._pendingPassages.push({ label: "", direction: "both" });
        }
        this.render({ force: true });
      });
    });

    // Direction axis: both → forward → backward → both (per row, independent)
    html.querySelectorAll(".ca-passage-direction").forEach(btn => {
      btn.addEventListener("click", () => {
        const i = parseInt(btn.closest("[data-index]").dataset.index, 10);
        const current = this._pendingPassages[i].direction ?? "both";
        this._pendingPassages[i] = { ...this._pendingPassages[i], direction: cycleLinkDirectionAxis(current) };
        this.render({ force: true });
      });
    });

    // State axis: open → blocked → locked → open (per row, independent)
    html.querySelectorAll(".ca-passage-state").forEach(btn => {
      btn.addEventListener("click", () => {
        const i = parseInt(btn.closest("[data-index]").dataset.index, 10);
        const current = this._pendingPassages[i].direction ?? "both";
        this._pendingPassages[i] = { ...this._pendingPassages[i], direction: cycleLinkStateAxis(current) };
        this.render({ force: true });
      });
    });

    // Label inputs update pending state live without triggering a re-render
    html.querySelectorAll(".ca-passage-label").forEach(input => {
      const i = parseInt(input.closest("[data-index]").dataset.index, 10);
      input.addEventListener("input", () => {
        // Enforce 100-char limit as a safeguard alongside the maxlength HTML attribute
        if (input.value.length > 100) input.value = input.value.slice(0, 100);
        this._pendingPassages[i] = { ...this._pendingPassages[i], label: input.value };
      });
    });

    html.querySelectorAll(".ca-display-mode-toggle").forEach(btn => {
      btn.addEventListener("click", () => {
        const i = parseInt(btn.closest("[data-index]").dataset.index, 10);
        const current = this._pendingPassages[i].displayMode ?? "full";
        this._pendingPassages[i] = { ...this._pendingPassages[i], displayMode: current === "path-only" ? "full" : "path-only" };
        this.render({ force: true });
      });
    });

    html.querySelector(".ca-link-editor-save")?.addEventListener("click", () => this._onSave());
    html.querySelector(".ca-convert-to-single")?.addEventListener("click", () => this._onConvertToSingle());
  }

  /**
   * Persists the pending passages array to the graph setting, sets forceMulti so the link
   * behaves as multi-passage even when only one passage remains, then refreshes all
   * open Click Adventure apps and closes this editor.
   * @returns {Promise<void>}
   */
  async _onSave() {
    const { nodes, links } = getGraphData();
    // Auto-fill any passage that was left without a name
    const normalisedPassages = this._pendingPassages.map((p, i) => ({
      ...p,
      label: p.label.trim() || `Path ${i + 1}`
    }));
    const updatedLinks = links.map((l, i) =>
      i === this._linkIndex
        ? { ...l, passages: structuredClone(normalisedPassages), forceMulti: true }
        : l
    );
    await saveGraphData({ nodes, links: updatedLinks });

    const manager = foundry.applications.instances.get("manager-app");
    if (manager?.rendered) manager.render({ force: true });
    const hud = globalThis.ClickAdventure?._hud;
    if (hud?.rendered) hud.render({ force: true });

    this.close();
  }

  /**
   * Reverts the link to single-passage mode: keeps only the first passage and clears forceMulti.
   * Called when the user clicks "Convert to single" in the editor footer.
   * @returns {Promise<void>}
   */
  async _onConvertToSingle() {
    const { nodes, links } = getGraphData();
    const first = this._pendingPassages[0] ?? { label: "", direction: "both" };
    const updatedLinks = links.map((l, i) =>
      i === this._linkIndex
        ? { ...l, passages: [{ ...first }], forceMulti: false }
        : l
    );
    await saveGraphData({ nodes, links: updatedLinks });

    const manager = foundry.applications.instances.get("manager-app");
    if (manager?.rendered) manager.render({ force: true });
    const hud = globalThis.ClickAdventure?._hud;
    if (hud?.rendered) hud.render({ force: true });

    this.close();
  }
}
