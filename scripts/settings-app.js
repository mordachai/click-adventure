/**
 * Settings window for the Click Adventure module.
 * Opens on click of the gear button in the Manager toolbar.
 * Replaces the previous frameless outside-click popover.
 *
 * Lifecycle hook: renderSettingsApp
 */


import { onResetGraph } from "./manager-scene-ops.js";
import { getActiveGroup, saveGraphData } from "./node-utils.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class SettingsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @override */
  static BASE_APPLICATION = ApplicationV2;

  /** @override */
  static DEFAULT_OPTIONS = {
    id: "settings-app",
    classes: ["click-adventure", "settings"],
    window: { title: "Click Adventure — Settings", resizable: false },
    position: { width: 560, height: "auto" }
  };

  /** @override */
  static PARTS = {
    panel: { template: "modules/click-adventure/templates/settings-app.hbs" }
  };

  /**
   * Id of the currently active tab. Held on the instance so the selected tab
   * survives re-renders (mirrors the pattern used by NodeConfigApp).
   * @type {string}
   */
  _activeTab = "scenes";

  /**
   * Provides the current settings values and all available transition options.
   * Triggered during the ApplicationV2 _prepareContext lifecycle stage.
   *
   * @override
   * @param {object} options
   * @returns {Promise<object>}
   */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    context.transitionType = game.settings.get("click-adventure", "transitionType");
    context.transitionOptions = [
      { value: "null",       label: "None" },
      { value: "fade",       label: "Fade" },
      { value: "swirl",      label: "Swirl" },
      { value: "waterDrop",  label: "Water Drop" },
      { value: "morph",      label: "Morph" },
      { value: "crosshatch", label: "Crosshatch" },
      { value: "wind",       label: "Wind" },
      { value: "waves",      label: "Waves" },
      { value: "whiteNoise", label: "White Noise" },
      { value: "hologram",   label: "Hologram" },
      { value: "hole",       label: "Hole" },
      { value: "holeSwirl",  label: "Hole Swirl" },
      { value: "glitch",     label: "Glitch" },
      { value: "dots",       label: "Dots" }
    ];

    context.guideModeAction = game.settings.get("click-adventure", "guideModeAction");

    context.hudVisibility = game.settings.get("click-adventure", "hudVisibility");
    context.hudVisibilityOptions = [
      { value: "all",     label: "All players" },
      { value: "gm-only", label: "GM only" }
    ];

    // Per-group flag (stored on the active group object, not a game setting).
    // Absent field is treated as enabled to preserve existing groups' behavior.
    context.loadPlayerTokens = getActiveGroup()?.loadPlayerTokens !== false;

    context.useDefaultTokenPositions = game.settings.get("click-adventure", "useDefaultTokenPositions");
    context.showPlayerWhisper = game.settings.get("click-adventure", "showPlayerWhisper");
    context.playerDestinationPreview = game.settings.get("click-adventure", "playerDestinationPreview");
    context.journalAutoOpen = game.settings.get("click-adventure", "journalAutoOpen");

    return context;
  }

  /**
   * Wires the transition select and guide-mode-action select so changes
   * are persisted immediately.
   * Triggered during the ApplicationV2 _onRender lifecycle stage.
   *
   * @override
   * @param {object} context
   * @param {object} options
   */
  _onRender(context, options) {
    super._onRender(context, options);

    // Tab switching — custom data-tab/data-panel pattern (no native TABS API),
    // matching NodeConfigApp. The active tab is restored on every render.
    const tabs   = this.element.querySelectorAll(".ca-settings-tab");
    const panels = this.element.querySelectorAll(".ca-settings-panel-tab");

    const activateTab = (tabName) => {
      tabs.forEach(t =>
        t.classList.toggle("ca-tab--active", t.dataset.tab === tabName)
      );
      panels.forEach(p =>
        p.classList.toggle("ca-settings-panel-tab--hidden", p.dataset.panel !== tabName)
      );
    };

    activateTab(this._activeTab);

    tabs.forEach(tab => {
      tab.addEventListener("click", () => {
        this._activeTab = tab.dataset.tab;
        activateTab(this._activeTab);
      });
    });

    this.element.querySelector(".ca-settings-transition")
      ?.addEventListener("change", async (e) => {
        await game.settings.set("click-adventure", "transitionType", e.target.value);
      });

    // Button groups (HUD Visibility + Guide Mode)
    this.element.querySelectorAll(".ca-btn-group").forEach(group => {
      group.querySelectorAll(".ca-btn-group-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          const setting = group.dataset.setting;
          const value   = btn.dataset.value;

          await game.settings.set("click-adventure", setting, value);

          group.querySelectorAll(".ca-btn-group-btn").forEach(b =>
            b.classList.toggle("ca-btn-group-btn--active", b === btn)
          );
        });
      });
    });

    // Sliding switches — generic handler for any boolean setting using data-setting
    this.element.querySelectorAll(".ca-switch[data-setting]").forEach(sw => {
      sw.addEventListener("click", async () => {
        const setting = sw.dataset.setting;
        const next    = !game.settings.get("click-adventure", setting);
        await game.settings.set("click-adventure", setting, next);
        sw.classList.toggle("ca-switch--on", next);
        sw.setAttribute("aria-checked", String(next));

        // Saved Positions only makes sense when tokens are loaded — enabling it
        // forces the per-group Load Player Tokens switch on.
        if (setting === "useDefaultTokenPositions" && next && getActiveGroup()?.loadPlayerTokens === false) {
          await saveGraphData({ loadPlayerTokens: true });
          const lpt = this.element.querySelector(".ca-load-player-tokens");
          lpt?.classList.add("ca-switch--on");
          lpt?.setAttribute("aria-checked", "true");
        }
      });
    });

    // Per-group "Load Player Tokens" switch — persists on the active group object
    // (not a game setting), so it cannot use the generic data-setting handler above.
    this.element.querySelector(".ca-load-player-tokens")
      ?.addEventListener("click", async function () {
        const next = getActiveGroup()?.loadPlayerTokens === false; // flip current state
        await saveGraphData({ loadPlayerTokens: next });
        this.classList.toggle("ca-switch--on", next);
        this.setAttribute("aria-checked", String(next));
      });

    this.element.querySelector(".ca-capture-token-pos")
      ?.addEventListener("click", async () => {
        const scene = canvas.scene;
        if (!scene) {
          ui.notifications.warn("Click Adventure: No active scene on canvas.");
          return;
        }

        const current = game.settings.get("click-adventure", "defaultTokenPositions") ?? {};
        const updated = { ...current };
        let count = 0;

        for (const token of scene.tokens) {
          if (!token.actorId) continue;
          const user = game.users.find(u => u.character?.id === token.actorId);
          if (!user) continue;
          updated[user.id] = { x: token.x, y: token.y };
          count++;
        }

        if (count === 0) {
          ui.notifications.warn("Click Adventure: No linked-actor tokens found in the current scene.");
          return;
        }

        await game.settings.set("click-adventure", "defaultTokenPositions", updated);

        // Auto-enable the switch if it was off
        const wasEnabled = game.settings.get("click-adventure", "useDefaultTokenPositions");
        if (!wasEnabled) {
          await game.settings.set("click-adventure", "useDefaultTokenPositions", true);
          const sw = this.element.querySelector('.ca-switch[data-setting="useDefaultTokenPositions"]');
          if (sw) {
            sw.classList.add("ca-switch--on");
            sw.setAttribute("aria-checked", "true");
          }
        }

        // Capturing positions implies token loading — force Load Player Tokens on.
        if (getActiveGroup()?.loadPlayerTokens === false) {
          await saveGraphData({ loadPlayerTokens: true });
          const lpt = this.element.querySelector(".ca-load-player-tokens");
          lpt?.classList.add("ca-switch--on");
          lpt?.setAttribute("aria-checked", "true");
        }

        ui.notifications.info(`Click Adventure: Saved default positions for ${count} player(s). Token placement enabled.`);
      });

    this.element.querySelector(".ca-reset-graph")
      ?.addEventListener("click", () => {
        const managerApp = globalThis.ClickAdventure?._manager;
        onResetGraph(managerApp ?? { render: () => {} });
      });
  }
}
