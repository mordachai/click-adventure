/**
 * AdventureIOApp — Export and import adventure groups (graphs) as JSON.
 *
 * Export: serialises selected graphs from the world setting to a downloadable
 * JSON file. Scene IDs are stripped, so nothing that lives on a Scene document
 * survives on its own — every cross-document reference (macro, linked scene,
 * journal page, playlist track) is written with name metadata alongside its id,
 * which is what lets the import side resolve it in a different world.
 *
 * Import: reads a previously exported JSON file, resolves those references
 * (id first, then name), creates Foundry Scenes for every node, and appends the
 * imported graphs to the world collection. Journal and music resolve into the
 * node's staging fields, which createSceneForNode bakes into the new Scene.
 *
 * Accessible via game.settings.registerMenu → Foundry module settings panel.
 * Restricted to GM users.
 *
 * Lifecycle hook: renderAdventureIOApp
 */

import { MODULE_ID } from "./constants.js";
import { getOrCreateGroupFolder, createSceneForNode } from "./manager-scene-ops.js";
import { getNodeJournal, getNodeMusic } from "./node-media.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class AdventureIOApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @override */
  static DEFAULT_OPTIONS = {
    id: "adventure-io-app",
    classes: ["click-adventure", "adventure-io"],
    window: { title: "Export / Import Adventure" },
    position: { width: 560, height: "auto" }
  };

  /** @override */
  static PARTS = {
    main: { template: "modules/click-adventure/templates/adventure-io-app.hbs" }
  };

  constructor(options = {}) {
    super(options);
    /**
     * Parsed JSON payload from a loaded import file.
     * @type {{ clickAdventureVersion: string, graphs: object[] }|null}
     */
    this._importData = null;
    /** @type {string} Display name of the loaded file. */
    this._importFileName = "";
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Provides the current graph list for export and, when a file is loaded,
   * the candidate graphs for import.
   *
   * @override
   * @param {object} options
   * @returns {Promise<object>}
   */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    const col = game.settings.get(MODULE_ID, "graphs");
    const raw = typeof col?.toObject === "function" ? col.toObject() : (col ?? {});
    context.graphs = (raw.graphs ?? []).map(g => ({
      id:        g.id,
      name:      g.name,
      nodeCount: (g.nodes ?? []).length,
      linkCount: (g.links ?? []).length
    }));

    if (this._importData) {
      context.importGraphs = (this._importData.graphs ?? []).map((g, i) => ({
        index:     i,
        name:      g.name,
        nodeCount: (g.nodes ?? []).length,
        linkCount: (g.links ?? []).length
      }));
      context.importFileName = this._importFileName;
    }

    return context;
  }

  /**
   * Wires all interactive elements after every render.
   * Called from the ApplicationV2 _onRender lifecycle stage.
   *
   * @override
   * @param {object} context
   * @param {object} options
   */
  _onRender(context, options) {
    super._onRender(context, options);
    const html = this.element;

    // ── Export panel ────────────────────────────────────────────────────────
    html.querySelector("[data-action='export-select-all']")?.addEventListener("click", () => {
      html.querySelectorAll(".ca-io-export-check").forEach(cb => { cb.checked = true; });
    });

    html.querySelector("[data-action='export-deselect-all']")?.addEventListener("click", () => {
      html.querySelectorAll(".ca-io-export-check").forEach(cb => { cb.checked = false; });
    });

    html.querySelector("[data-action='export']")?.addEventListener("click", () => {
      const selected = new Set(
        [...html.querySelectorAll(".ca-io-export-check:checked")].map(cb => cb.dataset.graphId)
      );
      if (selected.size === 0) {
        ui.notifications.warn("Click Adventure: Select at least one group to export.");
        return;
      }
      this._doExport(selected);
    });

    // ── Import panel ─────────────────────────────────────────────────────────
    html.querySelector(".ca-io-file-input")?.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!data.clickAdventureVersion || !Array.isArray(data.graphs)) {
          ui.notifications.error("Click Adventure: Invalid export file.");
          return;
        }
        this._importData     = data;
        this._importFileName = file.name;
        this.render({ force: true });
      } catch {
        ui.notifications.error("Click Adventure: Could not read file — is it valid JSON?");
      }
    });

    html.querySelector("[data-action='import-cancel']")?.addEventListener("click", () => {
      this._importData     = null;
      this._importFileName = "";
      this.render({ force: true });
    });

    html.querySelector("[data-action='import']")?.addEventListener("click", async () => {
      const indices = [...html.querySelectorAll(".ca-io-import-check:checked")]
        .map(cb => parseInt(cb.dataset.index, 10));
      if (indices.length === 0) {
        ui.notifications.warn("Click Adventure: Select at least one group to import.");
        return;
      }
      const selected = indices.map(i => this._importData.graphs[i]).filter(Boolean);
      await this._doImport(selected);
      this._importData     = null;
      this._importFileName = "";
      this.render({ force: true });
    });
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  /**
   * Builds the export payload, triggers a browser download, and notifies the GM.
   *
   * @param {Set<string>} selectedIds - graph IDs to include
   * @returns {void}
   */
  _doExport(selectedIds) {
    const col = game.settings.get(MODULE_ID, "graphs");
    const raw = typeof col?.toObject === "function" ? col.toObject() : (col ?? {});
    const selected = (raw.graphs ?? []).filter(g => selectedIds.has(g.id));

    const payload = {
      clickAdventureVersion: "1",
      exportDate:            new Date().toISOString(),
      graphs:                selected.map(g => this._serializeGraph(g))
    };

    const filename = `click-adventure-export-${Date.now()}.json`;
    const file     = new File([JSON.stringify(payload, null, 2)], filename, { type: "text/plain" });
    const url      = URL.createObjectURL(file);
    const a        = document.createElement("a");
    a.href         = url;
    a.download     = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    // bubbles:false prevents Foundry's document-level click handlers from intercepting.
    a.dispatchEvent(new MouseEvent("click", { bubbles: false, cancelable: true }));
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    ui.notifications.info(`Click Adventure: Exported ${selected.length} group(s).`);
  }

  /**
   * Serialises a graph entry for export.
   * - Strips sceneId from every node (scenes are recreated on import).
   * - Attaches macroName to every macro reference for name-based fallback resolution.
   * - Attaches sceneName to linked-scene entries for name-based lookup on import.
   * - Resets executedOnce flags so "once" macros fire again in the new world.
   *
   * @param {object} graph
   * @returns {object}
   */
  _serializeGraph(graph) {
    return {
      id:          graph.id,
      name:        graph.name,
      startNodeId: graph.startNodeId ?? "",
      nodes:       (graph.nodes ?? []).map(n => this._serializeNode(n)),
      links:       (graph.links ?? []).map(l => ({ ...l }))
    };
  }

  /**
   * @param {object} node
   * @returns {object}
   */
  _serializeNode(node) {
    return {
      id:               node.id,
      label:            node.label ?? "Scene",
      images:           (node.images ?? []).map(img => ({
        ...img,
        macro: img.macro ? this._serializeMacroRef(img.macro) : null
      })),
      activeImageIndex: node.activeImageIndex ?? 0,
      x:                node.x ?? 0,
      y:                node.y ?? 0,
      sceneId:          null,
      linkedScenes:     (node.linkedScenes ?? []).map(ls => ({
        ...ls,
        sceneId:   null,
        sceneName: game.scenes.get(ls.sceneId)?.name ?? ls.label ?? null,
        macro:     ls.macro ? this._serializeMacroRef(ls.macro) : null
      })),
      activeLinkedSceneId: node.activeLinkedSceneId ?? null,
      nodeMacros:       (node.nodeMacros ?? []).map(nm => ({
        ...nm,
        executedOnce: false,
        macroName:    game.macros.get(nm.macroId)?.name ?? null
      })),
      autolockMode:     node.autolockMode ?? "inherit",
      isCameraRoom:     node.isCameraRoom ?? false,
      cameraLabel:      node.cameraLabel ?? "",
      journalTrigger:   node.journalTrigger ?? "view",
      journal:          this._serializeJournalRef(node),
      music:            this._serializeMusicRef(node)
    };
  }

  /**
   * Serialises the node's journal assignment. It normally lives on the node's Scene,
   * which export strips, so it is written out as an id + name pair — the id is what
   * makes a re-import into the same world exact, the name is what makes it work at all
   * in a different one.
   *
   * @param {object} node
   * @returns {{journalId: string, journalName: string, pageId: string|null, pageName: string|null}|null}
   */
  _serializeJournalRef(node) {
    const { journal, page } = getNodeJournal(node);
    if (!journal) return null;
    return {
      journalId:   journal.id,
      journalName: journal.name,
      pageId:      page?.id   ?? null,
      pageName:    page?.name ?? null
    };
  }

  /**
   * Serialises the node's music assignment, same reasoning as the journal above.
   * A null sound means the whole playlist was assigned, which Foundry honours by
   * following the playlist's own mode.
   *
   * @param {object} node
   * @returns {{playlistId: string, playlistName: string, soundId: string|null, soundName: string|null}|null}
   */
  _serializeMusicRef(node) {
    const { playlist, sound } = getNodeMusic(node);
    if (!playlist) return null;
    return {
      playlistId:   playlist.id,
      playlistName: playlist.name,
      soundId:      sound?.id   ?? null,
      soundName:    sound?.name ?? null
    };
  }

  /**
   * Enriches a macro reference with the current macro name.
   * @param {object} ref - { macroId, trigger, … }
   * @returns {object}
   */
  _serializeMacroRef(ref) {
    return {
      ...ref,
      macroName: game.macros.get(ref.macroId)?.name ?? ref.label ?? null
    };
  }

  // ---------------------------------------------------------------------------
  // Import
  // ---------------------------------------------------------------------------

  /**
   * Processes and persists selected graphs from the import payload.
   * For each graph:
   *   1. Resolves all macro references (UUID → world ID → name fallback).
   *   2. Resolves linked-scene references by scene name.
   *   3. Resolves journal and music references (id → name) into the node's staging fields.
   *   4. Creates a Foundry Scene for every node in the graph's own Scene folder, which is
   *      where the staged journal and music land; the staging fields are then cleared.
   *   5. Appends the graph to the world collection with a fresh ID.
   *
   * @param {object[]} graphs - graph objects from the import JSON
   * @returns {Promise<void>}
   */
  async _doImport(graphs) {
    ui.notifications.info("Click Adventure: Import started — creating scenes…");

    const warnings = [];

    const col = game.settings.get(MODULE_ID, "graphs");
    const raw = typeof col?.toObject === "function" ? col.toObject() : (col ?? {});
    let { activeGraphId }  = raw;
    const existingGraphs   = raw.graphs ?? [];
    const newGraphEntries  = [];

    for (const graph of graphs) {
      const newGraphId    = foundry.utils.randomID();
      const processedNodes = [];

      for (const node of (graph.nodes ?? [])) {
        const processed = await this._processNode(node, warnings);
        processedNodes.push(processed);
      }

      // Each imported graph gets its own Scene folder, keyed by its fresh id.
      const graphFolder = await getOrCreateGroupFolder({ id: newGraphId, name: graph.name });

      // Create Foundry Scenes immediately — no manual "Sync Scenes" step needed.
      for (let i = 0; i < processedNodes.length; i++) {
        const sceneId = await createSceneForNode(processedNodes[i], graphFolder.id);
        processedNodes[i] = {
          ...processedNodes[i],
          sceneId,
          pendingJournal: null,
          pendingMusic: null
        };
      }

      newGraphEntries.push({
        id:          newGraphId,
        name:        graph.name,
        startNodeId: graph.startNodeId ?? "",
        nodes:       processedNodes,
        links:       graph.links ?? []
      });

      // Activate the first imported graph if the world has none yet.
      if (!activeGraphId) activeGraphId = newGraphId;
    }

    await game.settings.set(MODULE_ID, "graphs", {
      activeGraphId,
      graphs: [...existingGraphs, ...newGraphEntries]
    });

    if (warnings.length > 0) {
      ui.notifications.warn(
        `Click Adventure: Import complete with ${warnings.length} warning(s) — see browser console.`
      );
      warnings.forEach(w => console.warn(`Click Adventure | Import: ${w}`));
    } else {
      ui.notifications.info(
        `Click Adventure: Imported ${graphs.length} group(s) successfully.`
      );
    }

    const manager = foundry.applications.instances.get("manager-app");
    if (manager?.rendered) manager.render({ force: true });
  }

  /**
   * Resolves all external references (macros, linked scenes) within a node
   * and returns a clean copy ready for persistence.
   *
   * @param {object}   node     - raw node from the import JSON
   * @param {string[]} warnings - mutable array; push human-readable warnings here
   * @returns {Promise<object>}
   */
  async _processNode(node, warnings) {
    const images = [];
    for (const img of (node.images ?? [])) {
      let macro = null;
      if (img.macro) {
        const id = await this._resolveMacroId(
          img.macro.macroId, img.macro.macroName,
          warnings, `Node "${node.label}" / image "${img.label}"`
        );
        macro = id ? { ...img.macro, macroId: id } : null;
      }
      images.push({ ...img, macro });
    }

    const linkedScenes = [];
    for (const ls of (node.linkedScenes ?? [])) {
      const scene = ls.sceneName
        ? (game.scenes.find(s => s.name === ls.sceneName) ?? null)
        : null;
      if (ls.sceneName && !scene) {
        warnings.push(
          `Node "${node.label}": linked scene "${ls.sceneName}" not found — reference cleared.`
        );
      }
      let macro = null;
      if (ls.macro) {
        const id = await this._resolveMacroId(
          ls.macro.macroId, ls.macro.macroName,
          warnings, `Node "${node.label}" / linked scene "${ls.label}"`
        );
        macro = id ? { ...ls.macro, macroId: id } : null;
      }
      linkedScenes.push({ ...ls, sceneId: scene?.id ?? null, macro });
    }

    const nodeMacros = [];
    for (const nm of (node.nodeMacros ?? [])) {
      const id = await this._resolveMacroId(
        nm.macroId, nm.macroName,
        warnings, `Node "${node.label}" / node macro`
      );
      if (id) nodeMacros.push({ ...nm, macroId: id, executedOnce: false });
    }

    // The export keys are the *references*; what gets persisted are the node's staging
    // fields, so pull them out of the spread rather than leaving strays on the node.
    const { journal: journalRef, music: musicRef, ...rest } = node;
    const pendingJournal = this._resolveJournalRef(journalRef, warnings, `Node "${node.label}"`);
    const pendingMusic   = this._resolveMusicRef(musicRef, warnings, `Node "${node.label}"`);

    return { ...rest, sceneId: null, images, linkedScenes, nodeMacros, pendingJournal, pendingMusic };
  }

  /**
   * Resolves an exported journal reference against this world.
   *
   * Resolution order, same shape as {@link _resolveMacroId}:
   *   1. `game.journal.get(journalId)`  — exact, for a re-import into the source world
   *   2. `game.journal.getName(name)`   — name fallback, for any other world
   *
   * A found entry whose page is missing is kept without the page rather than dropped:
   * the whole entry opening is closer to the author's intent than nothing opening.
   *
   * @param {object|null} ref      - the exported reference
   * @param {string[]}    warnings - mutable array; push human-readable warnings here
   * @param {string}      context  - prefix identifying the node in a warning
   * @returns {{journalId: string, pageId: string|null}|null}
   */
  _resolveJournalRef(ref, warnings, context) {
    if (!ref?.journalId && !ref?.journalName) return null;

    const entry = (ref.journalId ? game.journal.get(ref.journalId) : null)
      ?? (ref.journalName ? game.journal.getName(ref.journalName) : null);

    if (!entry) {
      warnings.push(`${context}: journal "${ref.journalName ?? ref.journalId}" not found — reference cleared.`);
      return null;
    }

    if (!ref.pageId && !ref.pageName) return { journalId: entry.id, pageId: null };

    const page = (ref.pageId ? entry.pages.get(ref.pageId) : null)
      ?? (ref.pageName ? entry.pages.find(p => p.name === ref.pageName) : null);

    if (!page) {
      warnings.push(
        `${context}: page "${ref.pageName ?? ref.pageId}" not found in journal "${entry.name}" — the whole entry will open instead.`
      );
      return { journalId: entry.id, pageId: null };
    }

    return { journalId: entry.id, pageId: page.id };
  }

  /**
   * Resolves an exported music reference against this world, same order and same
   * partial-match tolerance as {@link _resolveJournalRef}: a playlist found without its
   * track is kept, and Foundry falls back to the playlist's own playback mode.
   *
   * @param {object|null} ref      - the exported reference
   * @param {string[]}    warnings - mutable array; push human-readable warnings here
   * @param {string}      context  - prefix identifying the node in a warning
   * @returns {{playlistId: string, soundId: string|null}|null}
   */
  _resolveMusicRef(ref, warnings, context) {
    if (!ref?.playlistId && !ref?.playlistName) return null;

    const playlist = (ref.playlistId ? game.playlists.get(ref.playlistId) : null)
      ?? (ref.playlistName ? game.playlists.getName(ref.playlistName) : null);

    if (!playlist) {
      warnings.push(`${context}: playlist "${ref.playlistName ?? ref.playlistId}" not found — reference cleared.`);
      return null;
    }

    if (!ref.soundId && !ref.soundName) return { playlistId: playlist.id, soundId: null };

    const sound = (ref.soundId ? playlist.sounds.get(ref.soundId) : null)
      ?? (ref.soundName ? playlist.sounds.find(s => s.name === ref.soundName) : null);

    if (!sound) {
      warnings.push(
        `${context}: track "${ref.soundName ?? ref.soundId}" not found in playlist "${playlist.name}" — the whole playlist will be used instead.`
      );
      return { playlistId: playlist.id, soundId: null };
    }

    return { playlistId: playlist.id, soundId: sound.id };
  }

  /**
   * Resolves a macro reference to a usable macroId in the current world.
   *
   * Resolution order:
   *   1. `fromUuid(macroId)` — works for compendium UUIDs (Compendium.module.macros.id)
   *   2. `game.macros.get(macroId)` — works when source and destination are the same world
   *   3. `game.macros.find(m => m.name === macroName)` — name-based fallback
   *
   * @param {string|null} macroId   - stored macro ID or UUID
   * @param {string|null} macroName - name of the macro, for fallback resolution
   * @param {string[]}    warnings  - mutable warnings array
   * @param {string}      context   - human-readable location for the warning message
   * @returns {Promise<string|null>} resolved macroId, or null if not found
   */
  async _resolveMacroId(macroId, macroName, warnings, context) {
    if (macroId) {
      // UUID path — covers compendium macros
      try {
        const doc = await fromUuid(macroId);
        if (doc) return macroId;
      } catch { /* not a valid UUID */ }

      // Same-world path — macroId matches directly
      if (game.macros.get(macroId)) return macroId;
    }

    // Name-based fallback
    if (macroName) {
      const macro = game.macros.find(m => m.name === macroName);
      if (macro) return macro.id;
    }

    if (macroId || macroName) {
      warnings.push(`${context}: macro "${macroName ?? macroId}" not found — reference cleared.`);
    }
    return null;
  }
}
