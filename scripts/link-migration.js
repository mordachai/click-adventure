/**
 * One-time migration to the direction+state passage model (see the module doc comment in
 * node-utils.js above decomposeDirection). Every passage on every link, in every graph, is
 * rewritten in place to carry explicit `direction` ("both"/"forward"/"backward") and `state`
 * ("open"/"blocked"/"secret"/"custom") fields.
 *
 * Two input shapes are handled:
 *  - Ancient flat combined string (`link.direction` or `passage.direction` as e.g.
 *    "forward-blocked") — a straight decompose, no bug to fix here.
 *  - Interim independent per-side shape (`sourceState`/`targetState`, from a since-reverted
 *    redesign) — collapsed back via _collapseSourceTarget. That redesign's own migration had
 *    a real bug worth fixing here: the legacy runtime (getLinkStateFromSide) always forced
 *    "open" onto whichever side wasn't the passage's designated direction, even when that
 *    side should never have existed as a route at all. Any passage with one side "open" and
 *    the other gated is that exact artifact — the "open" side gets collapsed to "none"
 *    (i.e. dropped, expressed as the opposite direction) rather than kept as a real route.
 *
 * Runs once per world — detected from data shape (see needsLinkStateMigration) rather than
 * a stamped version, since the graphs setting is a strict DataModel that would silently drop
 * an extra top-level marker field. Called from the `ready` hook in click-adventure.js, GM-only.
 */

import { MODULE_ID } from "./constants.js";
import { decomposeDirection } from "./node-utils.js";

function _collectionRaw() {
  const col = game.settings.get(MODULE_ID, "graphs");
  return typeof col?.toObject === "function" ? col.toObject() : (col ?? {});
}

/**
 * Collapses a passage's old independent sourceState/targetState pair into {direction, state}.
 * @param {string} s - sourceState ("open"/"blocked"/"secret"/"custom"/"none")
 * @param {string} t - targetState (same enum)
 * @returns {{direction: string, state: string}}
 */
function _collapseSourceTarget(s, t) {
  if (s === "none" && t === "none") return { direction: "both", state: "blocked" }; // broken/degenerate — flag visibly rather than silently "open"
  if (s === "none") return { direction: "backward", state: t };
  if (t === "none") return { direction: "forward", state: s };
  if (s === t) return { direction: "both", state: s };
  // Asymmetric with neither side "none": one of these two is the legacy bug's forced-open
  // side (the real passage is one-way, gated on the other side); if neither is "open" this
  // is a leftover from the independent-side UI itself — best effort, keep the source side.
  if (s === "open") return { direction: "backward", state: t };
  if (t === "open") return { direction: "forward", state: s };
  return { direction: "forward", state: s };
}

/**
 * Derives {direction, state} for one passage, from whichever old shape it's still in.
 * @param {object} p
 * @param {string} [linkDirection] - link-level legacy direction, when the passage itself
 *   carries neither shape (very old single-passage links stored direction on the link).
 * @returns {{direction: string, state: string}}
 */
function _derivePassageDirectionState(p, linkDirection) {
  if (p.sourceState !== undefined || p.targetState !== undefined) {
    return _collapseSourceTarget(p.sourceState ?? "open", p.targetState ?? "open");
  }
  const { dirAxis, stateAxis } = decomposeDirection(p.direction ?? linkDirection ?? "both");
  return { direction: dirAxis, state: stateAxis };
}

/**
 * True when any non-peek link still has a passage missing `state` — i.e. hasn't been
 * through runLinkStateMigration yet. Detected from data shape rather than a stamped version
 * number: the graphs setting is a strict DataModel (see AdventureCollectionDataModel) whose
 * schema only defines activeGraphId/graphs, so an extra top-level marker field would be
 * silently dropped on the next write.
 * @returns {boolean}
 */
export function needsLinkStateMigration() {
  const raw = _collectionRaw();
  return (raw.graphs ?? []).some(g =>
    (g.links ?? []).some(l =>
      l.type !== "peek" && (l.passages ?? []).some(p => p.state === undefined)
    )
  );
}

/**
 * Downloads the full, unmodified graphs setting as a JSON file — a raw safety backup taken
 * right before every passage gets rewritten. Distinct from AdventureIOApp's portable export,
 * which strips sceneId and reshapes references for cross-world import; this one is a
 * byte-for-byte snapshot meant only to be restored by hand if something goes wrong.
 */
export function downloadRawBackup() {
  const raw = _collectionRaw();
  const filename = `click-adventure-backup-pre-migration-${Date.now()}.json`;
  const file = new File([JSON.stringify(raw, null, 2)], filename, { type: "text/plain" });
  const url  = URL.createObjectURL(file);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.dispatchEvent(new MouseEvent("click", { bubbles: false, cancelable: true }));
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Rewrites every passage on every link, in every graph, to explicit direction/state fields.
 * Operates on the raw setting directly (not getGraphData/saveGraphData, which only touch the
 * active graph) so inactive groups are migrated too. Idempotent — a passage that already has
 * `state` is left untouched, so needsLinkStateMigration correctly reports "done" afterwards
 * purely from data shape.
 * @returns {Promise<void>}
 */
export async function runLinkStateMigration() {
  const raw = _collectionRaw();
  const graphs = (raw.graphs ?? []).map(g => ({
    ...g,
    links: (g.links ?? []).map(l => {
      if (l.type === "peek") return l;
      const passages = (l.passages ?? [{ label: "", direction: l.direction ?? "both" }]).map(p => {
        if (p.state !== undefined) return p;
        const { sourceState, targetState, direction, ...rest } = p;
        return { ...rest, ..._derivePassageDirectionState(p, l.direction) };
      });
      const { direction, ...restLink } = l;
      return { ...restLink, passages, forceMulti: l.forceMulti ?? (passages.length > 1) };
    })
  }));

  await game.settings.set(MODULE_ID, "graphs", { ...raw, graphs });
}

/**
 * GM-only entry point, called from the ready hook. Offers a backup download before rewriting
 * data. Skippable — re-prompts next reload — since old-format passages still resolve
 * correctly through getPassageStateFromSide's legacy fallback, so nothing breaks if a GM
 * declines for now.
 * @returns {Promise<void>}
 */
export async function promptLinkStateMigration() {
  if (!game.user.isGM) return;
  if (!needsLinkStateMigration()) return;

  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: "Click Adventure — Update Passage Data" },
    classes: ["click-adventure", "ca-dialog"],
    content: `
      <p>Click Adventure now stores each passage as an explicit Direction (Both ways /
      Forward / Backward) and State (Open / Blocked / Secret / Custom) instead of the
      previous format.</p>
      <p>This rewrites every link's passage data now, one time. Recommended: export a
      backup first.</p>
    `,
    buttons: [
      { action: "backup", label: "Export Backup & Update", icon: "fa-solid fa-download", default: true },
      { action: "update",  label: "Update Without Backup" },
      { action: "skip",    label: "Skip For Now", class: "ca-btn--quiet" }
    ],
    rejectClose: false
  });

  if (!choice || choice === "skip") return;
  if (choice === "backup") downloadRawBackup();

  await runLinkStateMigration();
  ui.notifications.info("Click Adventure: Passage data updated to the Direction + State format.");

  const manager = foundry.applications.instances.get("manager-app");
  if (manager?.rendered) manager.render({ force: true });
  const hud = globalThis.ClickAdventure?._hud;
  if (hud?.rendered) hud.render({ force: true });
}
