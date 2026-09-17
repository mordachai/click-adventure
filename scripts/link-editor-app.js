/**
 * Editor sheet for the passages array of a link.
 *
 * Each passage has a direction (both/forward/backward — which side(s) it exists on at all)
 * and a state (open/blocked/secret/custom — the condition on the side(s) it exists on). A
 * one-way passage's non-designated side has no route at all; expressing a different state on
 * each side of one link needs two passages, not one — see the module doc comment in
 * node-utils.js. A link with exactly one passage behaves identically to the legacy
 * single-passage link. A link with 2+ passages is "multi-passage" — clicking it in the
 * Manager opens this sheet instead of cycling. Shift+click opens this sheet regardless of
 * passage count.
 *
 * Opened from ManagerApp._renderLinks via Shift+click or auto-open for multi-passage links.
 * Lifecycle hook: renderLinkEditorApp
 */

import { getGraphData, saveGraphData, cyclePassageDirection, cyclePassageState } from "./node-utils.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Resolves a dropped Item, Actor, Macro, or Scene into a "key" condition for a custom-state
 * passage. Macros are imported from a compendium into the world first, same as elsewhere in
 * the module, since macro.execute() requires a world document; Item/Actor/Scene are only
 * ever referenced for lookup, never executed, so a compendium source is left as-is.
 *
 * @param {DragEvent} event
 * @returns {Promise<object|null>} a key object ({type, ...idFields, label}), or null when
 *   the drop wasn't a supported document type
 */
async function _resolveKeyFromDrop(event) {
  let data;
  try { data = JSON.parse(event.dataTransfer.getData("text/plain")); }
  catch { return null; }

  if (!data?.uuid) return null;
  const doc = await fromUuid(data.uuid);
  if (!doc) return null;

  switch (data.type) {
    case "Item":
      return { type: "item", itemId: doc.id, itemName: doc.name, label: doc.name };
    case "Actor":
      return { type: "actor", actorId: doc.id, label: doc.name };
    case "Scene":
      return { type: "scene", sceneId: doc.id, label: doc.name };
    case "Macro": {
      let macro = doc;
      if (macro.pack) {
        const pack = game.packs.get(macro.pack);
        if (!pack) return null;
        const existing = game.macros.find(m => m.name === macro.name && !m.pack);
        macro = existing ?? await game.macros.importFromCompendium(pack, macro.id);
      }
      return { type: "macro", macroId: macro.id, label: macro.name };
    }
    default:
      return null;
  }
}

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
     * @type {Array<{label: string, direction: string, state: string}>|null}
     */
    this._pendingPassages = null;
  }



  /**
   * Provides passage rows and endpoint labels to the editor template.
   * Pending passages are seeded from the persisted link only on the very first call so that
   * in-progress edits survive re-renders triggered by Add / Remove / a state cycle.
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
      const stored = link.passages ?? [{ label: "", direction: "both", state: "open" }];
      this._pendingPassages = structuredClone(stored);
    }

    const srcNode = nodes.find(n => n.id === link.sourceId);
    const tgtNode = nodes.find(n => n.id === link.targetId);
    context.fromLabel  = srcNode?.label || link.sourceId;
    context.toLabel    = tgtNode?.label || link.targetId;
    // Inject numeric index and per-passage display mode flag for the template
    context.passages = this._pendingPassages.map((p, i) => {
      const direction = p.direction ?? "both";
      const state = p.state ?? "open";
      return {
        ...p,
        index: i,
        displayModeIsPathOnly: (p.displayMode ?? "full") === "path-only",
        direction,
        state,
        hasCustom: state === "custom",
        keyMode: p.keyMode ?? "AND",
        lockedVisibility: p.lockedVisibility ?? "blocked",
        keys: (p.keys ?? []).map((k, ki) => ({ ...k, keyIndex: ki }))
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
      this._pendingPassages.push({ label: "", direction: "both", state: "open" });
      this.render({ force: true });
    });

    html.querySelectorAll(".ca-passage-remove").forEach(btn => {
      btn.addEventListener("click", () => {
        const i = parseInt(btn.closest("[data-index]").dataset.index, 10);
        this._pendingPassages.splice(i, 1);
        // Always keep at least one passage row
        if (this._pendingPassages.length === 0) {
          this._pendingPassages.push({ label: "", direction: "both", state: "open" });
        }
        this.render({ force: true });
      });
    });

    // Direction: both → forward → backward → both (per row, independent)
    html.querySelectorAll(".ca-passage-direction").forEach(btn => {
      btn.addEventListener("click", () => {
        const i = parseInt(btn.closest("[data-index]").dataset.index, 10);
        const current = this._pendingPassages[i].direction ?? "both";
        this._pendingPassages[i] = { ...this._pendingPassages[i], direction: cyclePassageDirection(current) };
        this.render({ force: true });
      });
    });

    // State: open → blocked → secret → custom → open (per row, independent)
    html.querySelectorAll(".ca-passage-state").forEach(btn => {
      btn.addEventListener("click", () => {
        const i = parseInt(btn.closest("[data-index]").dataset.index, 10);
        const current = this._pendingPassages[i].state ?? "open";
        this._pendingPassages[i] = { ...this._pendingPassages[i], state: cyclePassageState(current) };
        this.render({ force: true });
      });
    });

    // Custom state: key drop zone, per-key removal, and the AND/OR combinator toggle
    html.querySelectorAll(".ca-passage-key-dropzone").forEach(zone => {
      zone.addEventListener("dragover", e => {
        e.preventDefault();
        zone.classList.add("ca-dropzone--over");
      });
      zone.addEventListener("dragleave", () => zone.classList.remove("ca-dropzone--over"));
      zone.addEventListener("drop", async e => {
        e.preventDefault();
        zone.classList.remove("ca-dropzone--over");
        const key = await _resolveKeyFromDrop(e);
        if (!key) {
          ui.notifications.warn("Click Adventure: Drop an Item, Actor, Macro, or Scene.");
          return;
        }
        const i = parseInt(zone.dataset.index, 10);
        const keys = [...(this._pendingPassages[i].keys ?? []), key];
        this._pendingPassages[i] = { ...this._pendingPassages[i], keys };
        this.render({ force: true });
      });
    });

    html.querySelectorAll(".ca-passage-key-remove").forEach(btn => {
      btn.addEventListener("click", () => {
        const i  = parseInt(btn.dataset.index, 10);
        const ki = parseInt(btn.dataset.keyIndex, 10);
        const keys = [...(this._pendingPassages[i].keys ?? [])];
        keys.splice(ki, 1);
        this._pendingPassages[i] = { ...this._pendingPassages[i], keys };
        this.render({ force: true });
      });
    });

    html.querySelectorAll(".ca-passage-key-mode").forEach(btn => {
      btn.addEventListener("click", () => {
        const i = parseInt(btn.dataset.index, 10);
        const current = this._pendingPassages[i].keyMode ?? "AND";
        this._pendingPassages[i] = { ...this._pendingPassages[i], keyMode: current === "AND" ? "OR" : "AND" };
        this.render({ force: true });
      });
    });

    html.querySelectorAll(".ca-passage-locked-visibility").forEach(btn => {
      btn.addEventListener("click", () => {
        const i = parseInt(btn.dataset.index, 10);
        const current = this._pendingPassages[i].lockedVisibility ?? "blocked";
        this._pendingPassages[i] = { ...this._pendingPassages[i], lockedVisibility: current === "blocked" ? "secret" : "blocked" };
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
    const first = this._pendingPassages[0] ?? { label: "", direction: "both", state: "open" };
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
