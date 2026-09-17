/**
 * Per-node configuration panel. Opened via double-click on a node in ManagerApp.
 * Manages a list of images per node (multi-image support) and an activeImageIndex
 * that drives the Manager thumbnail and the tile texture when this node is current.
 * Changes are staged locally; the activeImageIndex is the only value that persists
 * immediately (to update the tile without waiting for Save).
 *
 * Lifecycle hook: renderNodeConfigApp
 */

import { syncNodeTile, getGraphData, saveGraphData, fireNodeMacros, setNodeActiveLinkedScene } from "./node-utils.js";
import {
  getNodeJournal, getNodeMusic, setNodeJournal, setNodeMusic,
  buildJournalTriggerOptions, DEFAULT_JOURNAL_TRIGGER, getNodeScene
} from "./node-media.js";

/**
 * Resolves a Foundry Macro from a drag-drop event.
 * Accepts both world macros and compendium macros.
 * Compendium macros are imported to the world before being returned,
 * since macro.execute() requires a world document.
 * Reuses an existing world macro of the same name to avoid duplicates.
 *
 * @param {DragEvent} event
 * @returns {Promise<Macro|null>}
 */
async function _resolveMacroFromDrop(event) {
  let data;
  try { data = JSON.parse(event.dataTransfer.getData("text/plain")); }
  catch { return null; }

  if (data?.type !== "Macro" || !data?.uuid) return null;

  let macro = await fromUuid(data.uuid);
  if (!macro) return null;

  if (macro.pack) {
    const pack = game.packs.get(macro.pack);
    if (!pack) return null;
    const existing = game.macros.find(m => m.name === macro.name && !m.pack);
    if (existing) {
      macro = existing;
    } else {
      macro = await game.macros.importFromCompendium(pack, macro.id);
      ui.notifications.info(`Click Adventure: Macro "${macro.name}" imported from compendium.`);
    }
  }

  return macro;
}

/**
 * Reads the Foundry drag payload from a drop event.
 * @param {DragEvent} event
 * @returns {{type: string, uuid: string}|null}
 */
function _readDropData(event) {
  try { return JSON.parse(event.dataTransfer.getData("text/plain")); }
  catch { return null; }
}

/**
 * Resolves a journal reference from a drop. Accepts a page (the normal case) or a whole
 * entry, which the Scene stores with a null page — Foundry then opens the entry itself.
 * Compendium documents are imported into the world first: a Scene's journal field holds
 * a world id, not a UUID, so a pack document could never be referenced by it.
 *
 * @param {DragEvent} event
 * @returns {Promise<{journalId: string, pageId: string|null}|null>}
 */
async function _resolveJournalFromDrop(event) {
  const data = _readDropData(event);
  if (!data?.uuid) return null;
  if (data.type !== "JournalEntryPage" && data.type !== "JournalEntry") return null;

  const doc = await fromUuid(data.uuid);
  if (!doc) return null;

  const isPage = doc.documentName === "JournalEntryPage";
  let entry = isPage ? doc.parent : doc;
  if (!entry) return null;

  if (entry.pack) {
    const pack = game.packs.get(entry.pack);
    if (!pack) return null;
    const existing = game.journal.find(j => j.name === entry.name && !j.pack);
    if (existing) {
      entry = existing;
    } else {
      entry = await game.journal.importFromCompendium(pack, entry.id);
      ui.notifications.info(`Click Adventure: Journal "${entry.name}" imported from compendium.`);
    }
    // The imported copy has fresh page ids — match the dropped page by name.
    const pageId = isPage ? (entry.pages.find(p => p.name === doc.name)?.id ?? null) : null;
    return { journalId: entry.id, pageId };
  }

  return { journalId: entry.id, pageId: isPage ? doc.id : null };
}

/**
 * Resolves a music reference from a drop. Accepts a single track or a whole playlist,
 * which the Scene stores with a null sound — Foundry then honours the playlist's own mode.
 * Compendium playlists are imported for the same reason as journals above.
 *
 * @param {DragEvent} event
 * @returns {Promise<{playlistId: string, soundId: string|null}|null>}
 */
async function _resolveMusicFromDrop(event) {
  const data = _readDropData(event);
  if (!data?.uuid) return null;
  if (data.type !== "PlaylistSound" && data.type !== "Playlist") return null;

  const doc = await fromUuid(data.uuid);
  if (!doc) return null;

  const isSound = doc.documentName === "PlaylistSound";
  let playlist = isSound ? doc.parent : doc;
  if (!playlist) return null;

  if (playlist.pack) {
    const pack = game.packs.get(playlist.pack);
    if (!pack) return null;
    const existing = game.playlists.find(p => p.name === playlist.name && !p.pack);
    if (existing) {
      playlist = existing;
    } else {
      playlist = await game.playlists.importFromCompendium(pack, playlist.id);
      ui.notifications.info(`Click Adventure: Playlist "${playlist.name}" imported from compendium.`);
    }
    const soundId = isSound ? (playlist.sounds.find(s => s.name === doc.name)?.id ?? null) : null;
    return { playlistId: playlist.id, soundId };
  }

  return { playlistId: playlist.id, soundId: isSound ? doc.id : null };
}

const VIDEO_EXTENSIONS = new Set(["webm", "mp4"]);

/**
 * Returns true if the given src path points to a supported video format.
 * @param {string} src
 * @returns {boolean}
 */
function isVideoSrc(src) {
  return VIDEO_EXTENSIONS.has(src?.split(".").pop()?.toLowerCase() ?? "");
}

const TRIGGER_OPTIONS = [
  { value: "gm-activate", label: "GM Activate → GM only"         },
  { value: "player-view", label: "Player View → Player only"     },
  { value: "gm-view",     label: "GM View → GM only"             },
  { value: "gm-any",      label: "GM View or Activate → GM only" }
];

/**
 * @param {string} selected
 * @returns {Array<{value:string, label:string, selected:boolean}>}
 */
function buildTriggerOptions(selected) {
  return TRIGGER_OPTIONS.map(o => ({ ...o, selected: o.value === selected }));
}

const NODE_MACRO_MODE_OPTIONS = [
  { value: "always", label: "Always" },
  { value: "once",   label: "Once"   }
];

/**
 * @param {string} selected
 * @returns {Array<{value:string, label:string, selected:boolean}>}
 */
function buildNodeMacroModeOptions(selected) {
  return NODE_MACRO_MODE_OPTIONS.map(o => ({ ...o, selected: o.value === selected }));
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class NodeConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @override */
  static BASE_APPLICATION = ApplicationV2;

  /** @override */
  static DEFAULT_OPTIONS = {
    id: "node-config-app",
    classes: ["click-adventure", "node-config"],
    window: { title: "Node Configuration" },
    position: { width: 820, height: "auto" }
  };

  /** @override */
  static PARTS = {
    config: {
      template: "modules/click-adventure/templates/node-config-app.hbs"
    }
  };

  /**
   * @param {string} nodeId - ID of the node being configured.
   * @param {object} [options={}]
   */
  constructor(nodeId, options = {}) {
    super(options);
    this.nodeId = nodeId;
    /** @type {Array<{id:string,src:string,label:string}>|null} */
    this._pendingImages = null;
    /** @type {number|null} */
    this._pendingActiveIndex = null;
    /** @type {string|null} */
    this._pendingLabel = null;
    /**
     * Tracks whether the user staged this node as the start point without saving yet.
     * null = no pending change; true = user wants this to be the start node.
     * Committed to the graph setting only on _saveAll.
     * @type {boolean|null}
     */
    this._pendingStartNode = null;
    /** @type {Array<{id:string, sceneId:string, label:string}>|null} */
    this._pendingLinkedScenes = null;
    /**
     * Id of the linkedScenes[] entry currently in use (replaces the images' Active badge).
     * undefined = not touched this session, fall back to the persisted node value;
     * null = explicitly cleared (an image was picked instead); string = an explicit entry.
     * @type {string|null|undefined}
     */
    this._activeLinkedSceneId = undefined;
    /** @type {string} Persists the active tab across force-renders */
    this._activeTab = "images";
    /** @type {Array<{id:string, macroId:string, trigger:string, executeMode:string, executedOnce:boolean}>|null} */
    this._pendingNodeMacros = null;
    /** @type {"open"|"inherit"|"locked"|null} */
    this._pendingAutolockMode = null;
    /** @type {boolean|null} */
    this._pendingIsCameraRoom = null;
    /** @type {string|null} */
    this._pendingCameraLabel = null;
  }



  /**
   * Provides node data including the working images list and activeIndex to the template.
   * Migrates legacy imageSrc nodes on the fly — committed only on Save.
   * Triggered during the ApplicationV2 _prepareContext lifecycle stage.
   *
   * @override
   * @param {object} options
   * @returns {Promise<object>}
   */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const { nodes, startNodeId } = getGraphData();
    const node = nodes.find(n => n.id === this.nodeId)
      ?? { id: this.nodeId, label: "Scene", images: [], activeImageIndex: 0, x: 0, y: 0 };

    let images = Array.isArray(node.images) ? node.images : [];
    if (images.length === 0 && node.imageSrc) {
      images = [{ id: foundry.utils.randomID(), src: node.imageSrc, label: "Default" }];
    }

    const activeIndex = this._pendingActiveIndex ?? node.activeImageIndex ?? 0;
    const workingImages = this._pendingImages ?? images;

    context.node = node;
    context.nodeLabel = this._pendingLabel ?? node.label ?? "Scene";
    context.isStartNode = this._pendingStartNode ?? (startNodeId === this.nodeId);
    const activeLinkedSceneId = this._activeLinkedSceneId !== undefined
      ? this._activeLinkedSceneId
      : (node.activeLinkedSceneId ?? null);
    const linkedSceneInUse = activeLinkedSceneId !== null;
    context.images = workingImages.map((img, i) => ({
      ...img,
      index:          i,
      isActive:       !linkedSceneInUse && i === activeIndex,
      isVideo:        isVideoSrc(img.src),
      hasMacro:       !!img.macro,
      macroName:      img.macro ? (game.macros.get(img.macro.macroId)?.name ?? "(not found)") : null,
      triggerOptions: img.macro ? buildTriggerOptions(img.macro.trigger) : []
    }));
    context.activeIndex = activeIndex;

    const persistedLinkedScenes = Array.isArray(node.linkedScenes) ? node.linkedScenes : [];
    const workingLinkedScenes = this._pendingLinkedScenes ?? persistedLinkedScenes;
    context.linkedScenes = workingLinkedScenes.map((ls, i) => ({
      ...ls,
      index:          i,
      sceneName:      game.scenes.get(ls.sceneId)?.name ?? "(Scene not found)",
      isActive:       ls.id === activeLinkedSceneId,
      hasMacro:       !!ls.macro,
      macroName:      ls.macro ? (game.macros.get(ls.macro.macroId)?.name ?? "(not found)") : null,
      triggerOptions: ls.macro ? buildTriggerOptions(ls.macro.trigger) : []
    }));

    const persistedNodeMacros = Array.isArray(node.nodeMacros) ? node.nodeMacros : [];
    const workingNodeMacros = this._pendingNodeMacros ?? persistedNodeMacros;
    context.nodeMacros = workingNodeMacros.map(entry => ({
      ...entry,
      macroName:        game.macros.get(entry.macroId)?.name ?? `Unknown (${entry.macroId})`,
      triggerOptions:   buildTriggerOptions(entry.trigger),
      modeOptions:      buildNodeMacroModeOptions(entry.executeMode),
      showExecutedBadge: entry.executeMode === "once" && entry.executedOnce === true
    }));

    // Journal and music read straight from the node's Scene (or the staged reference when
    // it has none), so they are never staged in the app the way images and macros are.
    const { journal, page } = getNodeJournal(node);
    context.hasScene = !!getNodeScene(node);
    context.journal = {
      has:            !!journal,
      title:          journal ? (page ? `${journal.name} — ${page.name}` : journal.name) : "",
      triggerOptions: buildJournalTriggerOptions(node.journalTrigger ?? DEFAULT_JOURNAL_TRIGGER)
    };

    const { playlist, sound } = getNodeMusic(node);
    context.music = {
      has:   !!playlist,
      title: playlist ? (sound ? `${playlist.name} — ${sound.name}` : `${playlist.name} (whole playlist)`) : ""
    };

    context.autolockMode = this._pendingAutolockMode ?? node.autolockMode ?? "inherit";
    context.isCameraRoom = this._pendingIsCameraRoom ?? node.isCameraRoom ?? false;
    context.cameraLabel  = this._pendingCameraLabel  ?? node.cameraLabel  ?? "";

    return context;
  }

  /**
   * Wires all image management actions: add, set-active, remove, rename, save, delete.
   * Triggered during the ApplicationV2 _onRender lifecycle stage.
   *
   * @override
   * @param {object} context
   * @param {object} options
   */
  _onRender(context, options) {
    super._onRender(context, options);
    const html = this.element;

    html.querySelector("[data-action='toggle-start']")?.addEventListener("click", () => {
      const { startNodeId } = getGraphData();
      const currentlyStart = this._pendingStartNode ?? (startNodeId === this.nodeId);
      if (currentlyStart) return;

      // Stage the intent locally — nothing is written until Save
      this._pendingStartNode = true;

      const btn = html.querySelector("[data-action='toggle-start']");
      if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-star" aria-hidden="true"></i> Start Node';
        btn.title = "This is the start node (click another node to change)";
        btn.classList.remove("ca-btn--toggle");
        btn.classList.add("ca-btn--toggle-on");
      }
    });

    html.querySelector("[data-action='add-image']")?.addEventListener("click", () => {
      const FilePickerClass = foundry.applications.apps.FilePicker.implementation
        ?? foundry.applications.apps.FilePicker;
      new FilePickerClass({
        type: "imagevideo",
        callback: (path) => {
          const images = this._getWorkingImages();
          images.push({ id: foundry.utils.randomID(), src: path, label: "Image " + (images.length + 1) });
          this._pendingImages = images;
          this.render({ force: true });
        }
      }).browse();
    });

    // Persists immediately so the tile updates if this is the current node
    html.querySelectorAll("[data-action='set-active']").forEach(btn => {
      btn.addEventListener("click", async () => {
        const idx = parseInt(btn.dataset.index, 10);
        this._pendingActiveIndex = idx;
        this._activeLinkedSceneId = null;   // limpa o estado de linked scene ativa
        await this._saveActiveIndex(idx);
        this.render({ force: true });
      });
    });

    html.querySelectorAll("[data-action='remove-image']").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.index, 10);
        const images = this._getWorkingImages();
        images.splice(idx, 1);
        this._pendingImages = images;
        const currentActive = this._pendingActiveIndex ?? context.activeIndex;
        if (currentActive >= images.length) {
          this._pendingActiveIndex = Math.max(0, images.length - 1);
        }
        this.render({ force: true });
      });
    });

    html.querySelectorAll(".ca-image-label-input").forEach(input => {
      input.addEventListener("change", () => {
        const idx = parseInt(input.dataset.index, 10);
        const images = this._getWorkingImages();
        if (images[idx]) images[idx].label = input.value.trim() || "Image";
        this._pendingImages = images;
      });
    });

    html.querySelector("[data-action='save']")?.addEventListener("click", async () => {
      const labelInput = html.querySelector(".ca-node-label-input");
      const label = labelInput?.value.trim().slice(0, 100) || "Scene";
      await this._saveAll(label);
    });

    html.querySelector("[data-action='delete-node']")?.addEventListener("click", async () => {
      await this._deleteNode();
    });

    // Drop zone — accepts Scene drag from the Scene Directory
    const dropzone = html.querySelector(".ca-linked-scenes-dropzone");
    if (dropzone) {
      dropzone.addEventListener("dragover", (event) => {
        event.preventDefault();
        dropzone.classList.add("ca-linked-scenes-dropzone--over");
      });
      dropzone.addEventListener("dragleave", () => {
        dropzone.classList.remove("ca-linked-scenes-dropzone--over");
      });
      dropzone.addEventListener("drop", (event) => {
        event.preventDefault();
        dropzone.classList.remove("ca-linked-scenes-dropzone--over");

        let data;
        try { data = JSON.parse(event.dataTransfer.getData("text/plain")); }
        catch { return; }

        if (data?.type !== "Scene" || !data?.uuid) return;

        const scene = fromUuidSync(data.uuid);
        if (!scene) return;

        // Prevent duplicates
        const linked = this._getWorkingLinkedScenes();
        if (linked.some(ls => ls.sceneId === scene.id)) {
          ui.notifications.warn("Click Adventure: This scene is already linked to this node.");
          return;
        }

        linked.push({
          id: foundry.utils.randomID(),
          sceneId: scene.id,
          label: scene.name
        });
        this._pendingLinkedScenes = linked;
        this.render({ force: true });
      });
    }

    // Use — view linked scene for GM and all active players on this node
    html.querySelectorAll("[data-action='use-linked-scene']").forEach(btn => {
      btn.addEventListener("click", async () => {
        const idx = parseInt(btn.dataset.index, 10);
        const linked = this._getWorkingLinkedScenes();
        const entry = linked[idx];
        if (!entry) return;

        const scene = game.scenes.get(entry.sceneId);
        if (!scene) {
          ui.notifications.error("Click Adventure: Linked scene not found. It may have been deleted.");
          return;
        }

        // Mark this linked scene as active, clearing image active badge. Persisted
        // immediately so navigating away and back shows this scene again.
        this._activeLinkedSceneId = entry.id;
        await setNodeActiveLinkedScene(this.nodeId, entry.id);
        this.render({ force: true });

        // GM: switch view locally
        await scene.view();

        // Players on this node: send via socket
        for (const user of game.users) {
          if (user.isGM || !user.active) continue;
          const userNodeId = user.getFlag("click-adventure", "currentNodeId");
          if (userNodeId !== this.nodeId) continue;
          await globalThis.ClickAdventure._socket.viewSceneForUser(entry.sceneId, user.id);
        }
      });
    });

    // Remove linked scene
    html.querySelectorAll("[data-action='remove-linked-scene']").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.index, 10);
        const linked = this._getWorkingLinkedScenes();
        linked.splice(idx, 1);
        this._pendingLinkedScenes = linked;
        this.render({ force: true });
      });
    });

    // Edit linked scene label
    html.querySelectorAll(".ca-linked-scene-label-input").forEach(input => {
      input.addEventListener("change", () => {
        const idx = parseInt(input.dataset.index, 10);
        const linked = this._getWorkingLinkedScenes();
        if (linked[idx]) linked[idx].label = input.value.trim() || "Scene";
        this._pendingLinkedScenes = linked;
      });
    });

    // ── Image macro drop zones ────────────────────────────────────────────
    html.querySelectorAll(".ca-image-macro-dropzone").forEach(zone => {
      zone.addEventListener("dragover", e => {
        e.preventDefault();
        zone.classList.add("ca-macro-dropzone--over");
      });
      zone.addEventListener("dragleave", () => zone.classList.remove("ca-macro-dropzone--over"));
      zone.addEventListener("drop", async e => {
        e.preventDefault();
        zone.classList.remove("ca-macro-dropzone--over");
        const macro = await _resolveMacroFromDrop(e);
        if (!macro) return;
        const idx = parseInt(zone.dataset.index, 10);
        const images = this._getWorkingImages();
        images[idx].macro = { macroId: macro.id, label: macro.name, trigger: "gm-activate" };
        this._pendingImages = images;
        this.render({ force: true });
      });
    });

    html.querySelectorAll("[data-action='remove-image-macro']").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.index, 10);
        const images = this._getWorkingImages();
        if (images[idx]) images[idx].macro = null;
        this._pendingImages = images;
        this.render({ force: true });
      });
    });

    html.querySelectorAll(".ca-image-macro-trigger").forEach(select => {
      select.addEventListener("change", () => {
        const idx = parseInt(select.dataset.index, 10);
        const images = this._getWorkingImages();
        if (images[idx]?.macro) images[idx].macro.trigger = select.value;
        this._pendingImages = images;
      });
    });

    html.querySelectorAll("[data-action='execute-image-macro']").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.index, 10);
        const images = this._getWorkingImages();
        const macroId = images[idx]?.macro?.macroId;
        if (!macroId) return;
        const macro = game.macros.get(macroId);
        if (!macro) { ui.notifications.warn("Click Adventure: Macro not found."); return; }
        macro.execute();
      });
    });

    html.querySelectorAll("[data-action='open-image-macro']").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.index, 10);
        const images = this._getWorkingImages();
        const macroId = images[idx]?.macro?.macroId;
        if (!macroId) return;
        const macro = game.macros.get(macroId);
        if (!macro) { ui.notifications.warn("Click Adventure: Macro not found."); return; }
        macro.sheet.render(true);
      });
    });

    // ── Linked scene macro drop zones ─────────────────────────────────────
    html.querySelectorAll(".ca-linked-scene-macro-dropzone").forEach(zone => {
      zone.addEventListener("dragover", e => {
        e.preventDefault();
        zone.classList.add("ca-macro-dropzone--over");
      });
      zone.addEventListener("dragleave", () => zone.classList.remove("ca-macro-dropzone--over"));
      zone.addEventListener("drop", async e => {
        e.preventDefault();
        zone.classList.remove("ca-macro-dropzone--over");
        const macro = await _resolveMacroFromDrop(e);
        if (!macro) return;
        const idx = parseInt(zone.dataset.index, 10);
        const linked = this._getWorkingLinkedScenes();
        linked[idx].macro = { macroId: macro.id, label: macro.name, trigger: "gm-activate" };
        this._pendingLinkedScenes = linked;
        this.render({ force: true });
      });
    });

    html.querySelectorAll("[data-action='remove-linked-scene-macro']").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.index, 10);
        const linked = this._getWorkingLinkedScenes();
        if (linked[idx]) linked[idx].macro = null;
        this._pendingLinkedScenes = linked;
        this.render({ force: true });
      });
    });

    html.querySelectorAll(".ca-linked-scene-macro-trigger").forEach(select => {
      select.addEventListener("change", () => {
        const idx = parseInt(select.dataset.index, 10);
        const linked = this._getWorkingLinkedScenes();
        if (linked[idx]?.macro) linked[idx].macro.trigger = select.value;
        this._pendingLinkedScenes = linked;
      });
    });

    html.querySelectorAll("[data-action='execute-linked-scene-macro']").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.index, 10);
        const linked = this._getWorkingLinkedScenes();
        const macroId = linked[idx]?.macro?.macroId;
        if (!macroId) return;
        const macro = game.macros.get(macroId);
        if (!macro) { ui.notifications.warn("Click Adventure: Macro not found."); return; }
        macro.execute();
      });
    });

    html.querySelectorAll("[data-action='open-linked-scene-macro']").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.index, 10);
        const linked = this._getWorkingLinkedScenes();
        const macroId = linked[idx]?.macro?.macroId;
        if (!macroId) return;
        const macro = game.macros.get(macroId);
        if (!macro) { ui.notifications.warn("Click Adventure: Macro not found."); return; }
        macro.sheet.render(true);
      });
    });

    // ── Node macro drop zone ─────────────────────────────────────────────
    const nodeMacroDropzone = html.querySelector(".ca-node-macro-drop");
    if (nodeMacroDropzone) {
      nodeMacroDropzone.addEventListener("dragover", e => {
        e.preventDefault();
        nodeMacroDropzone.classList.add("ca-node-macro-drop--over");
      });
      nodeMacroDropzone.addEventListener("dragleave", () => {
        nodeMacroDropzone.classList.remove("ca-node-macro-drop--over");
      });
      nodeMacroDropzone.addEventListener("drop", async e => {
        e.preventDefault();
        nodeMacroDropzone.classList.remove("ca-node-macro-drop--over");
        const macro = await _resolveMacroFromDrop(e);
        if (!macro) return;
        const macros = this._getWorkingNodeMacros();
        macros.push({
          id:          foundry.utils.randomID(),
          macroId:     macro.id,
          trigger:     "gm-view",
          executeMode: "always",
          executedOnce: false
        });
        this._pendingNodeMacros = macros;
        this.render({ force: true });
      });
    }

    html.querySelectorAll("[data-action='set-node-macro-trigger']").forEach(select => {
      select.addEventListener("change", () => {
        const entryId = select.dataset.macroId;
        const macros = this._getWorkingNodeMacros();
        const entry = macros.find(e => e.id === entryId);
        if (entry) entry.trigger = select.value;
        this._pendingNodeMacros = macros;
      });
    });

    html.querySelectorAll("[data-action='set-node-macro-mode']").forEach(select => {
      select.addEventListener("change", () => {
        const entryId = select.dataset.macroId;
        const macros = this._getWorkingNodeMacros();
        const entry = macros.find(e => e.id === entryId);
        if (!entry) return;
        entry.executeMode = select.value;
        // Switching back to "always" clears the fired flag
        if (select.value === "always") entry.executedOnce = false;
        this._pendingNodeMacros = macros;
        this.render({ force: true });
      });
    });

    html.querySelectorAll("[data-action='reset-node-macro']").forEach(btn => {
      btn.addEventListener("click", async () => {
        const entryId = btn.dataset.macroId;
        const macros = this._getWorkingNodeMacros();
        const entry = macros.find(e => e.id === entryId);
        if (!entry) return;
        entry.executedOnce = false;
        this._pendingNodeMacros = macros;
        // Persist immediately so the badge disappears without requiring Save
        const { sceneId, startNodeId, nodes, links } = getGraphData();
        const updatedNodes = nodes.map(n =>
          n.id === this.nodeId ? { ...n, nodeMacros: macros } : n
        );
        await saveGraphData({ sceneId, startNodeId, nodes: updatedNodes, links });
        this.render({ force: true });
      });
    });

    html.querySelectorAll("[data-action='run-node-macro']").forEach(btn => {
      btn.addEventListener("click", () => {
        const entryId = btn.dataset.macroId;
        const macros = this._getWorkingNodeMacros();
        const entry = macros.find(e => e.id === entryId);
        if (!entry) return;
        const macro = game.macros.get(entry.macroId);
        if (!macro) { ui.notifications.warn("Click Adventure: Macro not found."); return; }
        macro.execute();
      });
    });

    html.querySelectorAll("[data-action='open-node-macro']").forEach(btn => {
      btn.addEventListener("click", () => {
        const entryId = btn.dataset.macroId;
        const macros = this._getWorkingNodeMacros();
        const entry = macros.find(e => e.id === entryId);
        if (!entry) return;
        const macro = game.macros.get(entry.macroId);
        if (!macro) { ui.notifications.warn("Click Adventure: Macro not found."); return; }
        macro.sheet.render(true);
      });
    });

    html.querySelectorAll("[data-action='remove-node-macro']").forEach(btn => {
      btn.addEventListener("click", () => {
        const entryId = btn.dataset.macroId;
        const macros = this._getWorkingNodeMacros().filter(e => e.id !== entryId);
        this._pendingNodeMacros = macros;
        this.render({ force: true });
      });
    });

    // ── Autolock mode btn-group ──────────────────────────────────────────
    html.querySelectorAll("[data-field='autolockMode'] .ca-btn-group-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        this._pendingAutolockMode = btn.dataset.value;
        html.querySelectorAll("[data-field='autolockMode'] .ca-btn-group-btn").forEach(b => {
          b.classList.toggle("ca-btn-group-btn--active", b.dataset.value === this._pendingAutolockMode);
        });
      });
    });

    html.querySelector("[data-action='toggle-camera-room']")?.addEventListener("click", () => {
      const { nodes } = getGraphData();
      const node = nodes.find(n => n.id === this.nodeId);
      const current = this._pendingIsCameraRoom ?? node?.isCameraRoom ?? false;
      this._pendingIsCameraRoom = !current;
      // Re-render so the conditional camera label input appears or disappears
      this.render({ force: true });
    });

    html.querySelector(".ca-camera-label-input")?.addEventListener("change", (e) => {
      this._pendingCameraLabel = e.target.value.trim();
    });
    html.querySelector(".ca-camera-label-input")?.addEventListener("input", (e) => {
      this._pendingCameraLabel = e.target.value;
    });
    // ────────────────────────────────────────────────────────────────────

    // ── Journal tab ──────────────────────────────────────────────────────
    // Unlike images and macros, these write through immediately: the value lives on the
    // Scene document, not in the staged node data, so there is nothing for Save to commit.
    const _currentNode = () => getGraphData().nodes.find(n => n.id === this.nodeId);

    const _bindDropzone = (zone, resolve, apply) => {
      if (!zone) return;
      zone.addEventListener("dragover", e => {
        e.preventDefault();
        zone.classList.add("ca-media-drop--over");
      });
      zone.addEventListener("dragleave", () => zone.classList.remove("ca-media-drop--over"));
      zone.addEventListener("drop", async e => {
        e.preventDefault();
        zone.classList.remove("ca-media-drop--over");
        const ref = await resolve(e);
        if (!ref) {
          ui.notifications.warn("Click Adventure: that is not something this tab accepts.");
          return;
        }
        const node = _currentNode();
        if (!node) return;
        await apply(node, ref);
        this.render({ force: true });
      });
    };

    _bindDropzone(
      html.querySelector("[data-action='drop-journal']"),
      _resolveJournalFromDrop,
      (node, ref) => setNodeJournal(node, ref)
    );

    html.querySelector("[data-action='remove-journal']")?.addEventListener("click", async () => {
      const node = _currentNode();
      if (!node) return;
      await setNodeJournal(node, null);
      this.render({ force: true });
    });

    html.querySelector("[data-action='open-journal']")?.addEventListener("click", () => {
      const { journal, page } = getNodeJournal(_currentNode() ?? {});
      if (!journal) return;
      journal.sheet.render({ force: true, ...(page ? { pageId: page.id } : {}) });
    });

    html.querySelector("[data-action='set-journal-trigger']")?.addEventListener("change", async (e) => {
      const { sceneId, startNodeId, nodes, links } = getGraphData();
      const updatedNodes = nodes.map(n =>
        n.id === this.nodeId ? { ...n, journalTrigger: e.target.value } : n
      );
      await saveGraphData({ sceneId, startNodeId, nodes: updatedNodes, links });
    });
    // ────────────────────────────────────────────────────────────────────

    // ── Music tab ────────────────────────────────────────────────────────
    _bindDropzone(
      html.querySelector("[data-action='drop-music']"),
      _resolveMusicFromDrop,
      (node, ref) => setNodeMusic(node, ref)
    );

    html.querySelector("[data-action='remove-music']")?.addEventListener("click", async () => {
      const node = _currentNode();
      if (!node) return;
      await setNodeMusic(node, null);
      this.render({ force: true });
    });
    // ────────────────────────────────────────────────────────────────────

    // ── Tab switching ────────────────────────────────────────────────────
    const tabs       = html.querySelectorAll(".ca-nc-tab");
    const panels     = html.querySelectorAll(".ca-nc-panel");
    // Global per-tab actions live on the tab row rather than inside the panel,
    // so they have to follow the active tab themselves.
    const tabActions = html.querySelectorAll("[data-tab-action]");

    const _activateTab = (tabName) => {
      tabs.forEach(t => {
        t.classList.toggle("ca-tab--active", t.dataset.tab === tabName);
      });
      panels.forEach(p => {
        p.classList.toggle("ca-nc-panel--hidden", p.dataset.panel !== tabName);
      });
      tabActions.forEach(a => {
        a.hidden = a.dataset.tabAction !== tabName;
      });
    };

    // Restore the active tab on every render
    _activateTab(this._activeTab);

    tabs.forEach(tab => {
      tab.addEventListener("click", () => {
        this._activeTab = tab.dataset.tab;
        _activateTab(this._activeTab);
      });
    });
    // ────────────────────────────────────────────────────────────────────

    // ── Image thumb: preview tooltip + click-to-replace ──────────────────
    let _previewTooltip = document.getElementById("ca-image-preview-tooltip");
    if (!_previewTooltip) {
      _previewTooltip = document.createElement("div");
      _previewTooltip.id = "ca-image-preview-tooltip";
      _previewTooltip.className = "ca-image-preview-tooltip";
      document.body.appendChild(_previewTooltip);
    }

    if (!html._tooltipCleanupBound) {
      html._tooltipCleanupBound = true;
      html.addEventListener("mouseleave", () => {
        _previewTooltip.classList.remove("ca-tooltip--visible");
      });
    }

    html.querySelectorAll(".ca-image-thumb").forEach(thumb => {
      const src = thumb.dataset.src;

      thumb.addEventListener("mouseenter", () => {
        if (!src) return;
        const existingVideo = _previewTooltip.querySelector("video");
        existingVideo?.remove();
        if (isVideoSrc(src)) {
          _previewTooltip.style.backgroundImage = "";
          const vid = document.createElement("video");
          vid.src = src;
          vid.autoplay = true;
          vid.loop = true;
          vid.muted = true;
          vid.playsInline = true;
          vid.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
          _previewTooltip.appendChild(vid);
        } else {
          _previewTooltip.style.backgroundImage = `url("${src}")`;
        }
        _previewTooltip.classList.add("ca-tooltip--visible");
      });
      thumb.addEventListener("mousemove", (e) => {
        const offset = 16;
        let top = e.clientY - 160 - offset;
        if (top < 8) top = e.clientY + offset;
        _previewTooltip.style.top  = top + "px";
        _previewTooltip.style.left = (e.clientX - 110) + "px";
      });
      thumb.addEventListener("mouseleave", () => {
        _previewTooltip.classList.remove("ca-tooltip--visible");
        _previewTooltip.querySelector("video")?.remove();
        _previewTooltip.style.backgroundImage = "";
      });

      thumb.addEventListener("click", () => {
        const idx = parseInt(thumb.dataset.index, 10);
        const FilePickerClass = foundry.applications.apps.FilePicker.implementation
          ?? foundry.applications.apps.FilePicker;
        new FilePickerClass({
          type: "imagevideo",
          current: src,
          callback: (path) => {
            const images = this._getWorkingImages();
            if (images[idx]) images[idx].src = path;
            this._pendingImages = images;
            this.render({ force: true });
          }
        }).browse();
      });
    });
    // ────────────────────────────────────────────────────────────────────
  }

  /** @override */
  async close(options = {}) {
    const tooltip = document.getElementById("ca-image-preview-tooltip");
    tooltip?.remove();
    return super.close(options);
  }

  /**
   * Returns a mutable copy of the working images array, preferring pending state over persisted.
   * Handles legacy imageSrc-only nodes by wrapping in a single-item array.
   * @returns {Array<{id:string, src:string, label:string}>}
   */
  _getWorkingImages() {
    if (this._pendingImages !== null) return [...this._pendingImages];
    const { nodes } = getGraphData();
    const node = nodes.find(n => n.id === this.nodeId);
    let images = Array.isArray(node?.images) ? node.images : [];
    if (images.length === 0 && node?.imageSrc) {
      images = [{ id: foundry.utils.randomID(), src: node.imageSrc, label: "Default" }];
    }
    return [...images];
  }

  /**
   * Returns a mutable copy of the working linked scenes array.
   * @returns {Array<{id:string, sceneId:string, label:string}>}
   */
  _getWorkingLinkedScenes() {
    if (this._pendingLinkedScenes !== null) return [...this._pendingLinkedScenes];
    const { nodes } = getGraphData();
    const node = nodes.find(n => n.id === this.nodeId);
    return Array.isArray(node?.linkedScenes) ? [...node.linkedScenes] : [];
  }

  /**
   * Returns a mutable copy of the working node macros array.
   * @returns {Array<{id:string, macroId:string, trigger:string, executeMode:string, executedOnce:boolean}>}
   */
  _getWorkingNodeMacros() {
    if (this._pendingNodeMacros !== null) return [...this._pendingNodeMacros];
    const { nodes } = getGraphData();
    const node = nodes.find(n => n.id === this.nodeId);
    return Array.isArray(node?.nodeMacros) ? [...node.nodeMacros] : [];
  }

  /**
   * Persists the active image index immediately and syncs the node's managed background
   * tile via syncNodeTile. Called without waiting for the Save button.
   *
   * @param {number} index
   * @returns {Promise<void>}
   */
  async _saveActiveIndex(index) {
    const { sceneId, startNodeId, nodes, links } = getGraphData();
    const images = this._getWorkingImages();
    const updatedNodes = nodes.map(n => {
      if (n.id !== this.nodeId) return n;
      // An image and a linked scene can't both be active — picking an image reverts
      // the node to its own scene.
      return { ...n, images, activeImageIndex: index, activeLinkedSceneId: null };
    });
    await saveGraphData({ sceneId, startNodeId, nodes: updatedNodes, links });

    // Sync the tile in this node's own scene immediately
    const updatedNode = updatedNodes.find(n => n.id === this.nodeId);
    if (updatedNode) await syncNodeTile(updatedNode);

    // Navigate GM and all players currently on this node to the node's scene
    if (updatedNode?.sceneId) {
      const nodeSceneId = updatedNode.sceneId;

      // GM: switch view locally
      const gmScene = game.scenes.get(nodeSceneId);
      if (gmScene) await gmScene.view();

      // Players on this node: send via socket
      for (const user of game.users) {
        if (user.isGM || !user.active) continue;
        const userNodeId = user.getFlag("click-adventure", "currentNodeId");
        if (userNodeId !== this.nodeId) continue;
        await globalThis.ClickAdventure._socket.viewSceneForUser(nodeSceneId, user.id);
      }
    }

    const manager = foundry.applications.instances.get("manager-app");
    if (manager?.rendered) manager.render({ force: true });
  }

  /**
   * Persists all pending changes (label + images + activeIndex) in a single settings write.
   * Also syncs the scene name and background tile for this node's Foundry Scene.
   * Clears pending state, refreshes ManagerApp, and closes the panel.
   *
   * @param {string} label
   * @returns {Promise<void>}
   */
  async _saveAll(label) {
    const { sceneId, startNodeId: persistedStartNodeId, nodes, links } = getGraphData();
    const startNodeId = this._pendingStartNode ? this.nodeId : persistedStartNodeId;
    const images = this._getWorkingImages();
    const activeIndex = this._pendingActiveIndex ?? 0;
    const linkedScenes = this._getWorkingLinkedScenes();
    const nodeMacros = this._getWorkingNodeMacros();
    const persistedNode = nodes.find(n => n.id === this.nodeId);
    const autolockMode = this._pendingAutolockMode ?? (persistedNode?.autolockMode ?? "inherit");
    const isCameraRoom = this._pendingIsCameraRoom ?? (persistedNode?.isCameraRoom ?? false);
    const cameraLabel  = this._pendingCameraLabel  ?? (persistedNode?.cameraLabel  ?? "");
    const updatedNodes = nodes.map(n => {
      if (n.id !== this.nodeId) return n;
      return { ...n, label, images, activeImageIndex: activeIndex, linkedScenes, nodeMacros, autolockMode, isCameraRoom, cameraLabel, imageSrc: undefined };
    });
    await saveGraphData({ sceneId, startNodeId, nodes: updatedNodes, links });

    const updatedNode = updatedNodes.find(n => n.id === this.nodeId);
    if (updatedNode?.sceneId) {
      const scene = game.scenes.get(updatedNode.sceneId);
      if (scene) {
        const activeImg = images[activeIndex] ?? images[0] ?? null;
        const navName = activeImg?.label?.trim() || "";
        const sceneUpdate = {};
        if (scene.name !== label) sceneUpdate.name = label;
        if (scene.navName !== navName) sceneUpdate.navName = navName;
        if (Object.keys(sceneUpdate).length) await scene.update(sceneUpdate);
      }
      await syncNodeTile(updatedNode);
    }

    this._pendingImages = null;
    this._pendingActiveIndex = null;
    this._pendingLabel = null;
    this._pendingStartNode = null;
    this._pendingLinkedScenes = null;
    this._pendingNodeMacros = null;
    this._pendingAutolockMode = null;
    this._pendingIsCameraRoom = null;
    this._pendingCameraLabel = null;

    const manager = foundry.applications.instances.get("manager-app");
    if (manager?.rendered) manager.render({ force: true });
    const hud = globalThis.ClickAdventure?._hud;
    if (hud?.rendered) hud.render({ force: true });
    this.close();
  }

  /**
   * Deletes this node, all associated links, and its Foundry Scene after user confirmation.
   * Refreshes ManagerApp after deletion.
   *
   * @returns {Promise<void>}
   */
  async _deleteNode() {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Delete Node" },
      classes: ["click-adventure", "ca-dialog"],
      content: "<p>Delete this node, all its connections, and its Foundry Scene?</p>",
      yes: { class: "ca-btn ca-btn--danger" },
      no:  { class: "ca-btn ca-btn--quiet" },
      rejectClose: false
    });
    if (!confirmed) return;

    const { sceneId, startNodeId, nodes, links } = getGraphData();
    const deletedNode = nodes.find(n => n.id === this.nodeId);

    if (deletedNode?.sceneId) {
      const scene = game.scenes.get(deletedNode.sceneId);
      await scene?.delete();
    }

    const filteredNodes = nodes.filter(n => n.id !== this.nodeId);
    const filteredLinks = links.filter(l =>
      l.sourceId !== this.nodeId && l.targetId !== this.nodeId
    );
    // Clear startNodeId if the deleted node was the start
    const newStartNodeId = startNodeId === this.nodeId ? (filteredNodes[0]?.id ?? "") : startNodeId;
    await saveGraphData({ sceneId, startNodeId: newStartNodeId, nodes: filteredNodes, links: filteredLinks });

    const manager = foundry.applications.instances.get("manager-app");
    if (manager?.rendered) manager.render({ force: true });
    this.close();
  }
}
