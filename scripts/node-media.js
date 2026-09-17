/*!
 * Click Adventure
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

/**
 * Journal page and background music for a node.
 *
 * Both are shortcuts for fields the Foundry Scene already has — `journal` /
 * `journalEntryPage` and `playlist` / `playlistSound`. The node's Scene is the single
 * source of truth: opening the scene's own config in Foundry shows the same values, and
 * the native behaviour (Foundry starting the scene playlist when the scene is activated)
 * keeps working without this module doing anything.
 *
 * The one thing the Scene cannot hold is *when* to open the journal, so that lives on the
 * node as `journalTrigger`.
 *
 * A node created before "Create Scenes" has run has no Scene to write to. In that window
 * the chosen references are parked on the node (`pendingJournal` / `pendingMusic`) and
 * baked into the Scene creation data by createSceneForNode the moment the Scene exists —
 * a staging area, never a second source of truth, and cleared as soon as they are applied.
 */

import { getGraphData, saveGraphData } from "./node-utils.js";

/**
 * When the node's journal page opens. Stored on the node as `journalTrigger`.
 * "view" is the default because HUD navigation is per-client scene viewing;
 * "activate" only ever happens through the manager or Guide Mode.
 * @type {Array<{value: string, label: string}>}
 */
export const JOURNAL_TRIGGER_OPTIONS = [
  { value: "view",     label: "On Scene View"        },
  { value: "activate", label: "On Scene Activate"    },
  { value: "both",     label: "On View or Activate"  }
];

export const DEFAULT_JOURNAL_TRIGGER = "view";

/**
 * @param {string} selected
 * @returns {Array<{value:string, label:string, selected:boolean}>}
 */
export function buildJournalTriggerOptions(selected) {
  const current = selected ?? DEFAULT_JOURNAL_TRIGGER;
  return JOURNAL_TRIGGER_OPTIONS.map(o => ({ ...o, selected: o.value === current }));
}

/**
 * @param {object} node
 * @returns {Scene|null}
 */
export function getNodeScene(node) {
  return node?.sceneId ? (game.scenes.get(node.sceneId) ?? null) : null;
}

/**
 * Reads a Scene field that may arrive as a Document or as a raw id. The Scene schema is
 * not consistent here: `playlistSound` resolves to a PlaylistSound document while
 * `journalEntryPage` stays a plain id string, so every read goes through this.
 * @param {Document|string|null} value
 * @returns {string|null}
 */
function _idOf(value) {
  if (!value) return null;
  return typeof value === "string" ? value : (value.id ?? null);
}

/**
 * Resolves the journal reference configured for a node.
 * Reads the Scene when the node has one, and the staged reference when it does not.
 *
 * @param {object} node
 * @returns {{ journal: JournalEntry|null, page: JournalEntryPage|null }}
 */
export function getNodeJournal(node) {
  const scene = getNodeScene(node);
  const ref = scene
    ? { journalId: _idOf(scene.journal), pageId: _idOf(scene.journalEntryPage) }
    : (node?.pendingJournal ?? null);

  const journal = ref?.journalId ? (game.journal.get(ref.journalId) ?? null) : null;
  const page = journal && ref?.pageId ? (journal.pages.get(ref.pageId) ?? null) : null;
  return { journal, page };
}

/**
 * Resolves the music reference configured for a node.
 *
 * @param {object} node
 * @returns {{ playlist: Playlist|null, sound: PlaylistSound|null }}
 */
export function getNodeMusic(node) {
  const scene = getNodeScene(node);
  const ref = scene
    ? { playlistId: _idOf(scene.playlist), soundId: _idOf(scene.playlistSound) }
    : (node?.pendingMusic ?? null);

  const playlist = ref?.playlistId ? (game.playlists.get(ref.playlistId) ?? null) : null;
  const sound = playlist && ref?.soundId ? (playlist.sounds.get(ref.soundId) ?? null) : null;
  return { playlist, sound };
}

/**
 * Persists a journal reference for a node: onto its Scene when it has one, otherwise
 * staged on the node itself.
 *
 * @param {object} node
 * @param {{ journalId: string, pageId: string|null }|null} ref - null clears the assignment
 * @returns {Promise<void>}
 */
export async function setNodeJournal(node, ref) {
  const scene = getNodeScene(node);
  if (scene) {
    await scene.update({
      journal:          ref?.journalId ?? null,
      journalEntryPage: ref?.pageId    ?? null
    });
    if (node.pendingJournal) await _patchNode(node.id, { pendingJournal: null });
    return;
  }
  await _patchNode(node.id, { pendingJournal: ref });
}

/**
 * Persists a music reference for a node: onto its Scene when it has one, otherwise
 * staged on the node itself.
 *
 * @param {object} node
 * @param {{ playlistId: string, soundId: string|null }|null} ref - null clears the assignment
 * @returns {Promise<void>}
 */
export async function setNodeMusic(node, ref) {
  const scene = getNodeScene(node);
  if (scene) {
    await scene.update({
      playlist:      ref?.playlistId ?? null,
      playlistSound: ref?.soundId    ?? null
    });
    if (node.pendingMusic) await _patchNode(node.id, { pendingMusic: null });
    return;
  }
  await _patchNode(node.id, { pendingMusic: ref });
}

/**
 * Opens the node's journal page when the node's configured trigger matches, and only for
 * a user the document itself grants at least OBSERVER. Permission is the document's own —
 * a player without access simply gets nothing, with no error and no notification.
 *
 * Runs locally on the calling client. "view" is dispatched by whoever navigates;
 * "activate" is broadcast so every client evaluates its own permission.
 *
 * @param {object} node    - graph node object
 * @param {string} trigger - "view" | "activate"
 * @returns {Promise<void>}
 */
export async function openNodeJournal(node, trigger) {
  if (!game.settings.get("click-adventure", "journalAutoOpen")) return;

  const configured = node?.journalTrigger ?? DEFAULT_JOURNAL_TRIGGER;
  if (configured !== trigger && configured !== "both") return;

  const { journal, page } = getNodeJournal(node);
  if (!journal) return;

  const target = page ?? journal;
  if (!target.testUserPermission(game.user, "OBSERVER")) return;

  try {
    await journal.sheet.render({ force: true, ...(page ? { pageId: page.id } : {}) });
  } catch (err) {
    console.error(`Click Adventure | Failed to open journal "${journal.name}":`, err);
  }
}

/**
 * Merges a patch into a single node and persists the graph.
 * @param {string} nodeId
 * @param {object} patch
 * @returns {Promise<void>}
 */
async function _patchNode(nodeId, patch) {
  const { sceneId, startNodeId, nodes, links } = getGraphData();
  const updatedNodes = nodes.map(n => n.id === nodeId ? { ...n, ...patch } : n);
  await saveGraphData({ sceneId, startNodeId, nodes: updatedNodes, links });
}
