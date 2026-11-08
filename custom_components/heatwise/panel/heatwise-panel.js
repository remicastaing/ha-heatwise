import { LitElement, html, css } from "./vendor/lit-core.min.js";
import "./heatwise-schedule.js";
import "./heatwise-history.js";
import "./heatwise-house-history.js";
import { formatMoment, regulationLabel, temporaryTargetLabel } from "./heatwise-labels.js";

// Spec 012 : durées proposées pour une consigne temporaire (minutes).
const TEMPORARY_DURATIONS = [30, 60, 120, 180, 360, 720, 1440];

const VIEW_MODE_STORAGE_KEY = "heatwise-panel-view-mode";
// Spec 006 : seuil d'affichage « pile faible » (research R8). La règle
// de péremption (60 min) n'est volontairement pas ici : elle vient du
// backend via `room.sensor_stale` (research R6).
const LOW_BATTERY_THRESHOLD = 20;

function formatTargetTemperature(value) {
  return Number(value).toLocaleString("fr-FR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });
}

function formatMeasuredTemperature(value) {
  return Number(value).toLocaleString("fr-FR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

// HACS nomme les versions d'après les tags (« v0.0.6 ») ; le manifeste
// ne porte pas le « v » (spec 011, research R6).
function normalizeVersion(value) {
  return value ? String(value).replace(/^v/i, "") : value;
}

function formatHumidity(value) {
  return `${Math.round(Number(value))} %`;
}

function isNumeric(value) {
  return value !== null && value !== undefined && value !== "" && !Number.isNaN(Number(value));
}

// « dernière mesure à 14:32 » / « dernière mesure le 09/10 à 14:32 ».
function formatLastMeasure(iso) {
  const moment = formatMoment(iso);
  return `dernière mesure ${moment.startsWith("le ") ? moment : `à ${moment}`}`;
}

// Recherche insensible à la casse et aux accents.
function normalizeSearch(text) {
  return (text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// Version du code de ce panneau, lue dans l'URL de son module
// (`/heatwise_static/<version>/heatwise-panel.js`, cf. `__init__.py`).
// Après une mise à jour et un redémarrage, l'interface de Home Assistant
// se reconnecte sans recharger le JavaScript des panneaux : l'ancien code
// tournerait face au nouveau serveur. On recharge alors la page, une
// seule fois par version (garde contre une boucle de rechargements).
const PANEL_VERSION = (() => {
  const match = /\/heatwise_static\/([^/]+)\//.exec(import.meta.url);
  return match ? decodeURIComponent(match[1]) : null;
})();
const RELOAD_GUARD_KEY = "heatwise.reloadedForVersion";

// Actualisation des informations HACS du dépôt Heatwise : automatique à
// l'ouverture du panneau au plus une fois par heure, ou à la demande.
const HACS_REFRESH_KEY = "heatwise.hacsRefreshedAt";
const HACS_REFRESH_EVERY_MS = 60 * 60 * 1000;
// Code d'erreur de home-assistant-js-websocket quand la connexion tombe
// (attendu pendant un redémarrage de Home Assistant).
const ERR_CONNECTION_LOST = 3;

function hacsRefreshDue() {
  try {
    const last = Number(window.localStorage.getItem(HACS_REFRESH_KEY) || 0);
    return Date.now() - last >= HACS_REFRESH_EVERY_MS;
  } catch (err) {
    return true;
  }
}

function markHacsRefreshed() {
  try {
    window.localStorage.setItem(HACS_REFRESH_KEY, String(Date.now()));
  } catch (err) {
    // Sans stockage, l'actualisation se refera à la prochaine ouverture.
  }
}

function reloadForVersion(serverVersion) {
  try {
    if (window.sessionStorage.getItem(RELOAD_GUARD_KEY) === serverVersion) {
      return false;
    }
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, serverVersion);
  } catch (err) {
    // Sans stockage, pas de garde : on ne recharge pas, pour ne jamais boucler.
    return false;
  }
  window.location.reload();
  return true;
}

function loadStoredViewMode() {
  try {
    const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return stored === "list" ? "list" : "grid";
  } catch (err) {
    return "grid";
  }
}

function storeViewMode(mode) {
  try {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch (err) {
    // Stockage indisponible (navigation privée, quota...) : la
    // préférence ne sera simplement pas mémorisée d'une session à
    // l'autre, sans bloquer l'affichage du panneau.
  }
}

class HeatwisePanel extends LitElement {
  static properties = {
    hass: { attribute: false },
    narrow: { type: Boolean },
    panel: { attribute: false },
    _rooms: { state: true },
    _loaded: { state: true },
    _createDialogOpen: { state: true },
    _createName: { state: true },
    _createError: { state: true },
    _sensorDialog: { state: true },
    _sensorDissociation: { state: true },
    _sensorPairing: { state: true },
    _pairingNow: { state: true },
    _viewMode: { state: true },
    _pairing: { state: true },
    _settingsDialog: { state: true },
    _radiatorDeletion: { state: true },
    _renameDraft: { state: true },
    _roomDeletion: { state: true },
    _orphanRadiators: { state: true },
    _scheduleRoom: { state: true },
    _historyRoom: { state: true },
    _houseHistory: { state: true },
    _outdoor: { state: true },
    _generalSettingsDialog: { state: true },
    _generalSettings: { state: true },
    // Spec 011 : version et mises à jour (US3), chauffe 1 h (US2).
    _info: { state: true },
    _updateDialog: { state: true },
    _updateError: { state: true },
    _updateNotice: { state: true },
    _checkingUpdate: { state: true },
    _roomHeatingBusy: { state: true },
    _roomNotices: { state: true },
    // Spec 012 : consigne temporaire d'une pièce (FR-013b).
    _temporaryDialog: { state: true },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      --hw-bg: var(--primary-background-color, #f7f6f3);
      --hw-card: var(--card-background-color, #ffffff);
      --hw-border: var(--divider-color, #e5e3de);
      --hw-text: var(--primary-text-color, #1f1f1d);
      --hw-text-secondary: var(--secondary-text-color, #726f6a);
      --hw-accent: var(--primary-color, #0b84c4);
      --hw-accent-soft: rgba(11, 132, 196, 0.1);
      --hw-accent-border: rgba(11, 132, 196, 0.35);
      background: var(--hw-bg);
      height: 100vh;
      overflow-y: auto;
      box-sizing: border-box;
      padding: 28px 32px;
      font-family: var(--paper-font-body1_-_font-family, inherit);
    }

    .rooms-view {
      display: flex;
      flex-direction: column;
      min-height: 100%;
    }

    heatwise-schedule,
    heatwise-history,
    heatwise-house-history {
      flex: 1;
      min-height: 0;
    }

    .hint {
      color: var(--hw-text-secondary);
      font-size: 14px;
    }

    /* Spec 011 (FR-017) : en-tête — nom, version, actions générales. */
    .hw-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 18px;
    }

    .hw-title {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--hw-text);
      --mdc-icon-size: 26px;
    }

    .hw-title ha-icon {
      color: var(--hw-accent);
    }

    .hw-title h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 600;
    }

    .version-chip {
      padding: 2px 8px;
      border: none;
      border-radius: 999px;
      background: var(--hw-accent-soft);
      color: var(--hw-accent);
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }

    .version-chip:disabled {
      cursor: progress;
    }

    .update-banner {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      background: var(--hw-accent-soft);
      border: 1px solid var(--hw-accent-border);
      border-radius: 10px;
      padding: 10px 14px;
      margin-bottom: 16px;
      color: var(--hw-text);
      font-size: 13px;
      --mdc-icon-size: 18px;
    }

    .update-banner.alert {
      background: rgba(179, 38, 30, 0.08);
      border-color: rgba(179, 38, 30, 0.35);
      color: var(--error-color, #b3261e);
    }

    .update-banner .grow {
      flex: 1;
      min-width: 160px;
    }

    .update-banner a {
      color: var(--hw-accent);
      font-weight: 600;
    }

    .button-primary.small {
      padding: 6px 12px;
      font-size: 13px;
    }

    .view-toggle {
      display: flex;
      align-items: center;
      background: var(--hw-bg);
      border: 1px solid var(--hw-border);
      border-radius: 10px;
      padding: 3px;
    }

    .view-toggle-button {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 28px;
      border: none;
      border-radius: 7px;
      background: transparent;
      color: var(--hw-text-secondary);
      cursor: pointer;
      --mdc-icon-size: 16px;
    }

    .view-toggle-button.active {
      background: var(--hw-accent-soft);
      color: var(--hw-accent);
    }

    .button-primary {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 9px 16px;
      background: var(--hw-accent);
      border: none;
      border-radius: 10px;
      color: #ffffff;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }

    .dialog-overlay {
      position: fixed;
      inset: 0;
      background: rgba(30, 28, 25, 0.38);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10;
    }

    .dialog {
      width: 360px;
      background: var(--hw-card);
      border-radius: 16px;
      padding: 24px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .dialog h2 {
      margin: 0;
      font-size: 17px;
      font-weight: 600;
      color: var(--hw-text);
    }

    .dialog-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }

    .dialog-subtitle {
      font-size: 13px;
      color: var(--hw-text-secondary);
    }

    .icon-button {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border: none;
      background: transparent;
      border-radius: 8px;
      color: var(--hw-text-secondary);
      cursor: pointer;
      --mdc-icon-size: 16px;
    }
    .icon-button:hover {
      background: var(--hw-border);
    }

    .dialog label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: var(--hw-text);
      margin-bottom: 6px;
    }

    .dialog input {
      display: block;
      width: 100%;
      box-sizing: border-box;
      padding: 10px 12px;
      border: 1px solid var(--hw-border);
      border-radius: 9px;
      font-size: 14px;
      color: var(--hw-text);
    }

    .dialog input + label {
      margin-top: 14px;
    }

    .dialog-error {
      font-size: 12px;
      color: #b3261e;
    }

    .dialog-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }

    .button-secondary {
      padding: 9px 16px;
      background: transparent;
      border: 1px solid var(--hw-border);
      border-radius: 9px;
      color: var(--hw-text);
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }

    .rooms {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(270px, 1fr));
      gap: 18px;
    }

    .room-card {
      position: relative;
      background: var(--hw-card);
      border: 1px solid var(--hw-border);
      border-radius: 16px;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .room-header {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .room-icon {
      flex-shrink: 0;
      width: 38px;
      height: 38px;
      border-radius: 10px;
      background: var(--hw-accent-soft);
      color: var(--hw-accent);
      display: flex;
      align-items: center;
      justify-content: center;
      --mdc-icon-size: 20px;
    }

    .room-name {
      flex-grow: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 15px;
      font-weight: 600;
      color: var(--hw-text);
    }


    .current-temperature {
      font-size: 34px;
      font-weight: 600;
      color: var(--hw-text);
      line-height: 1;
    }

    .unavailable {
      font-size: 13px;
      font-style: italic;
      color: var(--hw-text-secondary);
    }

    .current-humidity {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      font-size: 15px;
      color: var(--hw-text-secondary);
      --mdc-icon-size: 16px;
    }

    .battery-alert {
      display: inline-flex;
      align-items: center;
      color: var(--error-color, #b3261e);
      --mdc-icon-size: 18px;
    }

    .target-temperature {
      font-size: 15px;
      color: var(--hw-text-secondary);
    }

    .pill-button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 12px;
      background: transparent;
      border-radius: 9px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }

    .pill-button.sensor {
      border: 1px dashed var(--hw-accent-border);
      color: var(--hw-accent);
    }

    .pill-button.radiator {
      border: 1px dashed var(--hw-border);
      color: var(--hw-text-secondary);
    }

    .pill-button.history {
      border: 1px solid var(--hw-border);
      color: var(--hw-text);
      margin-top: 12px;
    }

    .room-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .room-row {
      display: flex;
      align-items: center;
      gap: 16px;
      background: var(--hw-card);
      border: 1px solid var(--hw-border);
      border-radius: 12px;
      padding: 12px 16px;
    }

    .room-row .room-icon {
      width: 32px;
      height: 32px;
      --mdc-icon-size: 17px;
    }

    .room-row .room-name {
      flex-grow: 0;
      width: 140px;
      flex-shrink: 0;
    }


    .room-row .current-temperature {
      font-size: 18px;
    }

    /* Spec 011 (FR-018a) : puce d'état de régulation. */
    .regulation-chip {
      display: inline-flex;
      align-items: center;
      align-self: flex-start;
      gap: 5px;
      padding: 4px 10px;
      border: 1px solid var(--hw-border);
      border-radius: 999px;
      background: var(--hw-bg);
      color: var(--hw-text-secondary);
      font-size: 12.5px;
      font-weight: 600;
      --mdc-icon-size: 15px;
    }

    .regulation-chip.heating,
    .regulation-chip.manual {
      color: var(--state-climate-heat-color, #ff8100);
      background: rgba(255, 129, 0, 0.12);
      border-color: rgba(255, 129, 0, 0.35);
    }

    .regulation-chip.ok {
      color: var(--success-color, #43a047);
      background: rgba(67, 160, 71, 0.1);
      border-color: rgba(67, 160, 71, 0.3);
    }

    .regulation-chip.alert {
      color: var(--error-color, #b3261e);
      background: rgba(179, 38, 30, 0.08);
      border-color: rgba(179, 38, 30, 0.3);
    }

    .room-card.heating,
    .room-card.manual,
    .room-row.heating,
    .room-row.manual {
      border-color: rgba(255, 129, 0, 0.45);
    }

    .room-actions {
      display: flex;
      align-items: center;
      gap: 2px;
    }

    .measure-block {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .measure-main {
      display: flex;
      align-items: baseline;
      flex-wrap: wrap;
      gap: 10px;
    }

    .measure-secondary {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .target-temperature {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      --mdc-icon-size: 15px;
    }

    /* Spec 012 : consigne cliquable (consigne temporaire). */
    button.target-temperature {
      border: none;
      background: transparent;
      padding: 2px 4px;
      margin: -2px -4px;
      border-radius: 6px;
      font: inherit;
      cursor: pointer;
    }

    button.target-temperature:hover {
      background: var(--hw-accent-soft);
    }

    .target-temperature.temporary {
      color: var(--hw-accent);
      font-weight: 600;
    }

    .regulation-chip.temporary {
      color: var(--hw-accent);
      background: var(--hw-accent-soft);
      border-color: var(--hw-accent-border);
    }

    /* Spec 011 (US2) : action de chauffe en pied de pavé. */
    .room-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
      margin-top: auto;
      padding-top: 12px;
      border-top: 1px solid var(--hw-border);
    }

    .heat-button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 14px;
      border: 1px solid rgba(255, 129, 0, 0.45);
      border-radius: 999px;
      background: transparent;
      color: var(--state-climate-heat-color, #ff8100);
      font-size: 13px;
      font-weight: 600;
      white-space: nowrap;
      cursor: pointer;
      --mdc-icon-size: 16px;
    }

    .heat-button.stop {
      background: var(--state-climate-heat-color, #ff8100);
      border-color: transparent;
      color: #ffffff;
    }

    .heat-button:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .room-notice {
      flex: 1;
      font-size: 12px;
      color: var(--error-color, #b3261e);
    }

    .room-identity {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
    }

    .room-row .measure-block {
      flex-direction: row;
      align-items: center;
      flex-wrap: wrap;
      flex: 1 1 auto;
      min-width: 0;
      gap: 4px 12px;
    }

    .room-row .regulation-chip {
      display: block;
      align-self: center;
      max-width: 100%;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .room-row .regulation-chip ha-icon {
      vertical-align: -3px;
      margin-right: 4px;
    }

    .room-row .heat-button,
    .room-row .room-actions {
      flex-shrink: 0;
    }

    .room-row .room-notice {
      flex: 0 1 auto;
    }

    @media (max-width: 600px) {
      :host {
        padding: 16px;
      }

      .hw-header .header-actions {
        width: 100%;
        flex-wrap: wrap;
      }

      .toolbar-button .label,
      .outdoor-chip .label {
        display: none;
      }

      .rooms {
        grid-template-columns: 1fr;
      }

      .room-row {
        flex-wrap: wrap;
      }

      .room-row .room-identity {
        flex: 1 1 auto;
        min-width: 0;
      }

      .room-row .room-name {
        width: auto;
      }
    }

    .target-temperature-icon {
      display: inline-flex;
      align-items: center;
      color: var(--hw-text-secondary);
      --mdc-icon-size: 18px;
    }

    .button-secondary:disabled,
    .button-primary:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .section-title {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
      color: var(--hw-text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .add-radiator {
      width: auto;
      padding: 0 6px;
      gap: 2px;
      --mdc-icon-size: 16px;
    }

    .sensor-dialog {
      width: min(440px, calc(100vw - 32px));
      box-sizing: border-box;
      max-height: calc(100vh - 32px);
      overflow-y: auto;
    }

    .sensor-dialog select,
    .dialog select.temporary-duration,
    .dialog select.outdoor-source {
      display: block;
      width: 100%;
      box-sizing: border-box;
      padding: 10px 12px;
      border: 1px solid var(--hw-border);
      border-radius: 9px;
      font-size: 14px;
      color: var(--hw-text);
      background: var(--hw-card);
    }

    .pairing-start {
      justify-content: center;
      --mdc-icon-size: 18px;
    }

    .pairing-steps {
      margin: 0;
      padding-left: 20px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 14px;
      color: var(--hw-text);
    }

    .pairing-countdown {
      margin: 0;
      display: flex;
      align-items: baseline;
      gap: 10px;
      font-size: 28px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: var(--hw-text);
    }

    .pairing-status {
      margin: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 15px;
      font-weight: 600;
      color: var(--hw-text);
      --mdc-icon-size: 20px;
    }

    .pairing-status.success ha-icon {
      color: var(--hw-accent);
    }

    .pairing-notice {
      margin: 0;
      padding: 8px 10px;
      border-radius: 9px;
      background: var(--hw-accent-soft);
      font-size: 13px;
      color: var(--hw-text);
    }

    .pairing-causes {
      margin: 0;
      padding-left: 20px;
    }

    .pairing-measures {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 14px;
      color: var(--hw-text);
    }

    .pairing-measure {
      font-weight: 600;
    }

    .pairing-measure.pending {
      font-weight: 400;
      color: var(--hw-text-secondary);
    }

    .sensor-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 280px;
      overflow-y: auto;
    }

    .sensor-choice {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 8px 10px;
      background: transparent;
      border: 1px solid var(--hw-border);
      border-radius: 9px;
      text-align: left;
      color: var(--hw-text);
      cursor: pointer;
      --mdc-icon-size: 18px;
    }

    .sensor-choice.selected {
      border-color: var(--hw-accent-border);
      background: var(--hw-accent-soft);
    }

    .sensor-choice:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .sensor-choice-text,
    .sensor-summary-text {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .sensor-name {
      font-size: 14px;
      color: var(--hw-text);
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .sensor-detail {
      font-size: 12px;
      color: var(--hw-text-secondary);
    }

    .sensor-detail.low-battery {
      color: var(--error-color, #b3261e);
    }

    .sensor-summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 10px;
    }

    .sensor-actions {
      display: flex;
      gap: 8px;
    }

    .radiator-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .radiator-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 0;
    }

    .radiator-name {
      font-size: 14px;
      color: var(--hw-text);
    }

    .radiator-toggle {
      width: 32px;
      height: 32px;
      border-radius: 9px;
      background: var(--hw-bg);
      color: var(--hw-text-secondary);
      --mdc-icon-size: 18px;
    }

    .radiator-toggle.heating {
      background: var(--hw-accent-soft);
      color: var(--hw-accent);
    }

    .radiator-delete {
      color: var(--hw-text-secondary);
    }

    .radiator-delete:hover {
      color: var(--error-color, #b3261e);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .toolbar-button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 12px;
      background: transparent;
      border: 1px solid var(--hw-border);
      border-radius: 9px;
      color: var(--hw-text-secondary);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      --mdc-icon-size: 16px;
    }

    .outdoor-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 4px;
      color: var(--hw-text);
      font-size: 13px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      --mdc-icon-size: 16px;
    }

    .outdoor-chip ha-icon,
    .outdoor-chip .label {
      color: var(--hw-text-secondary);
      font-weight: 500;
    }

    .toolbar-button.active {
      background: rgba(249, 115, 22, 0.12);
      border-color: rgba(249, 115, 22, 0.4);
      color: #9a4b0a;
    }

    .button-danger {
      padding: 9px 16px;
      background: transparent;
      border: 1px solid rgba(179, 38, 30, 0.4);
      border-radius: 9px;
      color: var(--error-color, #b3261e);
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }

    .button-danger.filled {
      background: var(--error-color, #b3261e);
      border-color: transparent;
      color: #ffffff;
    }

    .button-danger:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .rename-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .rename-row input {
      flex: 1;
    }

    .deletion-summary {
      margin: 0;
      padding-left: 20px;
    }

    .room-deletion-footer {
      display: flex;
      justify-content: flex-start;
      border-top: 1px solid var(--hw-border);
      padding-top: 16px;
    }

    .orphan-section {
      margin-top: 24px;
      background: var(--hw-card);
      border: 1px solid var(--hw-border);
      border-radius: 16px;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .vacation-banner {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(249, 115, 22, 0.12);
      color: #9a4b0a;
      border-radius: 10px;
      padding: 10px 14px;
      font-size: 13px;
      margin-bottom: 16px;
      --mdc-icon-size: 16px;
    }
  `;

  constructor() {
    super();
    this._rooms = [];
    this._loaded = false;
    this._createDialogOpen = false;
    this._createName = "";
    this._createError = null;
    // Spec 009 : renommage (brouillon du champ Nom de la fenêtre de
    // paramètres), suppression de pièce, radiateurs sans pièce.
    this._renameDraft = null;
    this._roomDeletion = null;
    this._orphanRadiators = [];
    this._sensorDialog = null;
    this._sensorDissociation = null;
    // Appairage d'une sonde Zigbee (spec 007) : étape affichée dans la
    // fenêtre « Associer une sonde », et ressources de l'abonnement.
    this._sensorPairing = null;
    this._pairingNow = Date.now();
    this._pairingSession = null; // jeton stable de l'abonnement en cours
    this._pairingUnsub = null;
    this._pairingTimer = null;
    this._pairingDisconnectListener = null;
    // Reconnexion après un redémarrage de Home Assistant : relire la
    // version du serveur (et recharger la page si elle a changé).
    this._readyConnection = null;
    this._onConnectionReady = () => {
      this._loadInfo();
    };
    this._onKeyDown = (event) => {
      if (event.key === "Escape" && this._sensorDialog) {
        this._closeSensorDialog();
      }
    };
    this._viewMode = loadStoredViewMode();
    this._pairing = null;
    this._settingsDialog = null;
    this._radiatorDeletion = null;
    this._scheduleRoom = null;
    this._historyRoom = null;
    // Spec 013 (US4) : historique de toute la maison, température extérieure.
    this._houseHistory = false;
    this._outdoor = null;
    this._generalSettingsDialog = null;
    this._generalSettings = {
      default_temperature: 16,
      vacation_mode: false,
      history_interval: 10,
      outdoor_entity_id: null,
    };
    this._outdoorSources = [];
    this._minuteTimer = null;
    this._unsubEvents = [];
    this._info = null;
    this._updateDialog = null;
    this._updateError = null;
    this._updateNotice = null;
    this._checkingUpdate = false;
    this._roomHeatingBusy = {};
    this._roomNotices = {};
  }

  connectedCallback() {
    super.connectedCallback();
    this._scheduleMinuteTick();
    window.addEventListener("keydown", this._onKeyDown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this._onKeyDown);
    // FR-005 : quitter le panneau arrête l'appairage (réseau refermé).
    this._stopSensorPairing();
    if (this._minuteTimer) {
      clearTimeout(this._minuteTimer);
      this._minuteTimer = null;
    }
    this._unsubEvents.forEach((unsub) => unsub());
    this._unsubEvents = [];
    if (this._readyConnection) {
      this._readyConnection.removeEventListener("ready", this._onConnectionReady);
      this._readyConnection = null;
    }
  }

  _scheduleMinuteTick() {
    // FR-028/SC-008 : la consigne courante affichée sur les pavés suit
    // les frontières de plage au plus une minute après ; on ne pousse
    // pas d'entité HA dédiée cette itération (research.md R7).
    const delay = 60000 - (Date.now() % 60000);
    this._minuteTimer = setTimeout(() => {
      this._loadRooms();
      this._loadGeneralSettings();
      this._scheduleMinuteTick();
    }, delay);
  }

  _openScheduleView(room) {
    this._scheduleRoom = { room_id: room.room_id, name: room.name };
  }

  async _closeScheduleView() {
    this._scheduleRoom = null;
    await this._loadRooms();
  }

  // Spec 010 : historique d'une pièce, depuis le pavé ou ses paramètres.
  _openHistoryView(room) {
    this._settingsDialog = null;
    this._renameDraft = null;
    this._historyRoom = { room_id: room.room_id, name: room.name };
  }

  _closeHistoryView() {
    this._historyRoom = null;
  }

  // Spec 013 (US4) : historique de toutes les pièces et de l'extérieur.
  _openHouseHistory() {
    this._houseHistory = true;
  }

  _closeHouseHistory() {
    this._houseHistory = false;
  }

  // --- Paramètres généraux et mode vacances (US4, US7) ---

  async _loadGeneralSettings() {
    try {
      const response = await this.hass.connection.sendMessagePromise({
        type: "heatwise/get_settings",
      });
      this._generalSettings = response.settings;
      this._outdoorSources = response.outdoor_sources || [];
      this._outdoor = response.outdoor || null;
    } catch (err) {
      // Repli silencieux sur les valeurs par défaut déjà affichées.
    }
  }

  async _openGeneralSettingsDialog() {
    await this._loadGeneralSettings();
    this._generalSettingsDialog = {
      defaultTemperature: String(this._generalSettings.default_temperature),
      historyInterval: String(this._generalSettings.history_interval ?? 10),
      outdoorEntityId: this._generalSettings.outdoor_entity_id || "",
      error: null,
    };
  }

  // Spec 013 : source de la température extérieure (enregistrement seul).
  _onOutdoorSourceChange(event) {
    this._generalSettingsDialog = {
      ...this._generalSettingsDialog,
      outdoorEntityId: event.target.value,
      error: null,
    };
  }

  _closeGeneralSettingsDialog() {
    this._generalSettingsDialog = null;
  }

  _onDefaultTemperatureInput(event) {
    this._generalSettingsDialog = {
      ...this._generalSettingsDialog,
      defaultTemperature: event.target.value,
      error: null,
    };
  }

  _onHistoryIntervalInput(event) {
    this._generalSettingsDialog = {
      ...this._generalSettingsDialog,
      historyInterval: event.target.value,
      error: null,
    };
  }

  async _saveGeneralSettings() {
    const value = Number(this._generalSettingsDialog.defaultTemperature);
    if (Number.isNaN(value) || value < 7 || value > 25) {
      this._generalSettingsDialog = {
        ...this._generalSettingsDialog,
        error: "Entre 7 et 25 °C, par pas de 0,5.",
      };
      return;
    }
    // Spec 010 (FR-009, FR-011) : fréquence de l'historique.
    const interval = Number(this._generalSettingsDialog.historyInterval);
    if (!Number.isInteger(interval) || interval < 1 || interval > 60) {
      this._generalSettingsDialog = {
        ...this._generalSettingsDialog,
        error: "La fréquence doit être un nombre entier de minutes entre 1 et 60.",
      };
      return;
    }
    try {
      const response = await this.hass.connection.sendMessagePromise({
        type: "heatwise/update_settings",
        default_temperature: value,
        history_interval: interval,
        outdoor_entity_id: this._generalSettingsDialog.outdoorEntityId,
      });
      this._generalSettings = response.settings;
      this._generalSettingsDialog = null;
      await this._loadRooms();
    } catch (err) {
      this._generalSettingsDialog = {
        ...this._generalSettingsDialog,
        error:
          err && (err.code === "invalid_history_interval" || err.code === "invalid_outdoor_source")
            ? err.message
            : "Température invalide : entre 7 et 25 °C, par pas de 0,5.",
      };
    }
  }

  async _toggleVacationMode() {
    try {
      const response = await this.hass.connection.sendMessagePromise({
        type: "heatwise/update_settings",
        vacation_mode: !this._generalSettings.vacation_mode,
      });
      this._generalSettings = response.settings;
      await this._loadRooms();
    } catch (err) {
      // Best-effort : l'état affiché reste celui d'avant la bascule.
    }
  }

  _setViewMode(mode) {
    this._viewMode = mode;
    storeViewMode(mode);
  }

  updated(changedProps) {
    if (changedProps.has("hass") && !this._loaded) {
      this._loaded = true;
      this._loadRooms();
      this._loadGeneralSettings();
      this._loadInfo();
      this._readyConnection = this.hass.connection;
      this._readyConnection.addEventListener("ready", this._onConnectionReady);
      // `area_registry_updated` : association de sonde faite depuis
      // Heatwise ou depuis Paramètres → Zones (spec 006, research R7).
      // `heatwise_regulation_updated` : état de régulation d'une pièce
      // changé (spec 008, research R8).
      for (const eventType of [
        "heatwise_schedule_updated",
        "area_registry_updated",
        "heatwise_regulation_updated",
      ]) {
        this.hass.connection
          .subscribeEvents(() => this._onRoomsChanged(eventType), eventType)
          .then((unsub) => {
            this._unsubEvents.push(unsub);
          });
      }
    }
  }

  _onRoomsChanged(eventType) {
    this._loadRooms();
    if (eventType === "heatwise_schedule_updated") {
      this._loadGeneralSettings();
    }
    // La régulation change l'état de chauffe des radiateurs : rafraîchir
    // la fenêtre de la pièce si elle est ouverte (spec 008).
    if (
      eventType === "heatwise_regulation_updated" &&
      this._settingsDialog &&
      !this._settingsDialog.loading
    ) {
      this._loadSettingsRadiators();
    }
  }

  async _loadRooms() {
    const response = await this.hass.connection.sendMessagePromise({
      type: "heatwise/list_rooms",
    });
    this._rooms = response.rooms;
    this._orphanRadiators = response.orphan_radiators || [];
    // Spec 009 : pièce supprimée ailleurs (Paramètres → Zones, autre
    // fenêtre) pendant que ses fenêtres sont ouvertes → on les ferme.
    if (this._settingsDialog && !this._roomById(this._settingsDialog.room.room_id)) {
      this._closeSettingsDialog();
    }
    if (this._roomDeletion && !this._roomById(this._roomDeletion.room.room_id)) {
      this._roomDeletion = null;
    }
  }

  // --- Spec 011 : chauffer 1 h une pièce (US2) ---

  // Chauffe manuelle en cours : suspension de la pièce et au moins un
  // radiateur en chauffe (data-model, « État exposé au panneau »).
  _roomManualHeating(room) {
    return !!(room.regulation && room.regulation.suspended_until && room.heating);
  }

  async _setRoomManualHeating(room, heating) {
    const roomId = room.room_id;
    if (this._roomHeatingBusy[roomId]) {
      return;
    }
    this._roomHeatingBusy = { ...this._roomHeatingBusy, [roomId]: true };
    this._roomNotices = { ...this._roomNotices, [roomId]: null };
    let notice = null;
    try {
      const response = await this.hass.connection.sendMessagePromise({
        type: "heatwise/set_room_manual_heating",
        room_id: roomId,
        heating,
      });
      this._rooms = this._rooms.map((r) => (r.room_id === roomId ? response.room : r));
      const failed = response.failed_radiator_ids || [];
      if (failed.length) {
        notice =
          failed.length === 1
            ? "Un radiateur n'a pas reçu l'ordre : dongle injoignable."
            : `${failed.length} radiateurs n'ont pas reçu l'ordre : dongle injoignable.`;
      }
    } catch (err) {
      notice =
        err && err.code === "room_without_radiator"
          ? "Cette pièce n'a aucun radiateur."
          : this._pairingErrorMessage(err || {});
    }
    const { [roomId]: _done, ...busy } = this._roomHeatingBusy;
    this._roomHeatingBusy = busy;
    this._roomNotices = { ...this._roomNotices, [roomId]: notice };
  }

  // --- Spec 011 : version et mises à jour via HACS (US3) ---

  async _loadInfo() {
    try {
      this._info = await this.hass.connection.sendMessagePromise({
        type: "heatwise/get_info",
      });
    } catch (err) {
      this._info = null;
      return;
    }
    const serverVersion = this._info.version ? String(this._info.version) : null;
    if (PANEL_VERSION && serverVersion && PANEL_VERSION !== serverVersion) {
      if (reloadForVersion(serverVersion)) {
        return;
      }
    }
    this._checkForUpdate(false);
  }

  // Demande à la source des mises à jour de relire la dernière version
  // de Heatwise : pour une entité HACS, `hacs/repository/refresh` (ce que
  // fait « Actualiser les informations », commande interne non
  // documentée) ; pour une autre intégration (constat en production en
  // 0.0.15), le service générique `homeassistant.update_entity`. En cas
  // d'échec, la vérification manuelle le signale.
  async _checkForUpdate(manual) {
    const repository = this._info && this._info.hacs_repository_id;
    const entityId = this._info && this._info.update_entity_id;
    if (!repository && !entityId) {
      if (manual) {
        this._updateNotice =
          "Aucune entité de mise à jour de Heatwise trouvée : vérification impossible.";
      }
      return;
    }
    if (this._checkingUpdate || (!manual && !hacsRefreshDue())) {
      return;
    }
    this._checkingUpdate = true;
    this._updateNotice = null;
    try {
      if (repository) {
        await this.hass.connection.sendMessagePromise({
          type: "hacs/repository/refresh",
          repository,
        });
      } else {
        await this.hass.callService("homeassistant", "update_entity", { entity_id: entityId });
      }
      markHacsRefreshed();
      if (manual) {
        // Laisser l'entité de mise à jour publier son nouvel état.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const status = this._updateStatus();
        if (status && status.kind === "none") {
          this._updateNotice = `Heatwise est à jour (v${status.version}).`;
        }
      }
    } catch (err) {
      if (manual) {
        this._updateNotice = "Vérification impossible : la source des mises à jour n'a pas répondu.";
      }
    } finally {
      this._checkingUpdate = false;
    }
  }


  // État dérivé de l'entité `update` HACS (data-model, « Information de
  // mise à jour ») : none, available, installing, restart.
  _updateStatus() {
    const info = this._info;
    if (!info) {
      return null;
    }
    const version = normalizeVersion(info.version);
    const entityId = info.update_entity_id;
    const state = entityId && this.hass ? this.hass.states[entityId] : null;
    const base = { version, entityId, kind: "none" };
    if (!state) {
      return base;
    }
    const attrs = state.attributes;
    const installed = normalizeVersion(attrs.installed_version);
    const latest = normalizeVersion(attrs.latest_version);
    if (attrs.in_progress) {
      const progress =
        typeof attrs.update_percentage === "number"
          ? attrs.update_percentage
          : typeof attrs.in_progress === "number"
            ? attrs.in_progress
            : null;
      return { ...base, kind: "installing", latest, progress };
    }
    if (installed && version && installed !== version) {
      return { ...base, kind: "restart", installed };
    }
    if (state.state === "on" && latest) {
      return { ...base, kind: "available", latest, releaseUrl: attrs.release_url };
    }
    return base;
  }

  _askUpdate() {
    this._updateDialog = { step: "install", status: this._updateStatus() };
  }

  _askRestart() {
    this._updateDialog = { step: "restart", status: this._updateStatus() };
  }

  _closeUpdateDialog() {
    this._updateDialog = null;
  }

  async _confirmUpdateDialog() {
    const { step, status } = this._updateDialog;
    this._updateDialog = null;
    this._updateError = null;
    this._updateNotice = null;
    if (step === "install") {
      // L'avancement se lit sur l'entité (`in_progress`) ; l'appel rend la
      // main une fois l'installation terminée.
      try {
        await this.hass.callService("update", "install", { entity_id: status.entityId });
      } catch (err) {
        this._updateError = `La mise à jour a échoué${err && err.message ? ` : ${err.message}` : ""}.`;
        return;
      }
    }
    // Redémarrage enchaîné ; la page se recharge ensuite d'elle-même
    // quand le serveur annonce la nouvelle version (`_loadInfo`).
    try {
      await this.hass.callService("homeassistant", "restart", {});
    } catch (err) {
      if (!err || err.code !== ERR_CONNECTION_LOST) {
        this._updateError =
          step === "install"
            ? "Mise à jour installée, mais Home Assistant n'a pas pu être redémarré : redémarrez-le pour l'appliquer."
            : "Le redémarrage de Home Assistant n'a pas pu être lancé.";
      }
    }
  }

  // --- Ajout d'un radiateur (US1) ---

  _pairingErrorMessage(err) {
    switch (err.code) {
      case "rfplayer_not_configured":
        return "Aucun dongle RFPlayer configuré : reconfigurez l'intégration Heatwise pour renseigner son port.";
      case "rfplayer_unreachable":
        return "Le dongle RFPlayer est injoignable. Vérifiez qu'il est bien branché.";
      case "room_not_found":
        return "Cette pièce n'existe plus.";
      case "no_transmitter_id_available":
        return "Plus aucune identité radio disponible pour un nouveau radiateur.";
      case "radiator_not_found":
        return "Ce radiateur n'existe plus.";
      default:
        return "Une erreur est survenue.";
    }
  }

  _startRadiatorPairing(room) {
    this._pairing = { room, step: "intro", transmitterId: null, error: null };
  }

  _cancelPairingIntro() {
    // FR-004 : aucun ordre radio n'a encore été envoyé, rien à annuler.
    this._pairing = null;
  }

  async _confirmPairingStart() {
    const { room } = this._pairing;
    this._pairing = { ...this._pairing, step: "sending", error: null };
    try {
      const response = await this.hass.connection.sendMessagePromise({
        type: "heatwise/pair_radiator",
        room_id: room.room_id,
      });
      this._pairing = {
        room,
        step: "waiting",
        transmitterId: response.transmitter_id,
        error: null,
      };
    } catch (err) {
      this._pairing = {
        room,
        step: "intro",
        transmitterId: null,
        error: this._pairingErrorMessage(err),
      };
    }
  }

  async _retryPairing() {
    const { room, transmitterId } = this._pairing;
    try {
      await this.hass.connection.sendMessagePromise({
        type: "heatwise/confirm_radiator_pairing",
        transmitter_id: transmitterId,
        room_id: room.room_id,
        success: false,
      });
    } catch (err) {
      // best effort : le renvoi de l'ordre ci-dessous prime.
    }
    await this._confirmPairingStart();
  }

  async _abandonPairing() {
    const { transmitterId } = this._pairing;
    if (transmitterId != null) {
      try {
        await this.hass.connection.sendMessagePromise({
          type: "heatwise/abandon_radiator_pairing",
          transmitter_id: transmitterId,
        });
      } catch (err) {
        // best effort (FR-012) : ne pas bloquer l'abandon sur
        // l'injoignabilité du dongle, rien n'a de toute façon été
        // persisté côté Heatwise.
      }
    }
    this._pairing = null;
  }

  async _confirmPairingSuccess() {
    const { room, transmitterId } = this._pairing;
    this._pairing = { ...this._pairing, step: "confirming", error: null };
    try {
      const response = await this.hass.connection.sendMessagePromise({
        type: "heatwise/confirm_radiator_pairing",
        transmitter_id: transmitterId,
        room_id: room.room_id,
        success: true,
      });
      this._pairing = {
        room,
        step: "name",
        transmitterId,
        name: response.default_name,
        error: null,
      };
    } catch (err) {
      this._pairing = {
        room,
        step: "waiting",
        transmitterId,
        error: this._pairingErrorMessage(err),
      };
    }
  }

  _onPairingNameInput(event) {
    this._pairing = { ...this._pairing, name: event.target.value, error: null };
  }

  async _savePairing() {
    const { room, transmitterId, name } = this._pairing;
    try {
      await this.hass.connection.sendMessagePromise({
        type: "heatwise/save_radiator",
        transmitter_id: transmitterId,
        room_id: room.room_id,
        name,
      });
    } catch (err) {
      const message =
        err.code === "invalid_name"
          ? "Le nom est obligatoire."
          : err.code === "name_already_used"
            ? "Ce nom est déjà utilisé par un radiateur."
            : this._pairingErrorMessage(err);
      this._pairing = { ...this._pairing, error: message };
      return;
    }
    this._pairing = null;
    await this._loadRooms();
    if (this._settingsDialog && this._settingsDialog.room.room_id === room.room_id) {
      await this._loadSettingsRadiators();
    }
  }

  // --- Écran de paramètres d'une pièce (US2, US3) ---

  async _openSettingsDialog(room) {
    this._settingsDialog = { room, radiators: [], loading: true, error: null };
    this._renameDraft = { roomId: room.room_id, value: room.name, dirty: false, busy: false, error: null };
    await this._loadSettingsRadiators();
  }

  _closeSettingsDialog() {
    this._settingsDialog = null;
    this._renameDraft = null;
    this._roomDeletion = null;
  }

  // --- Renommer une pièce (spec 009, US1) ---

  _onRenameInput(event) {
    this._renameDraft = { ...this._renameDraft, value: event.target.value, dirty: true, error: null };
  }

  async _submitRename(room) {
    const draft = this._renameDraft;
    const name = draft.value.trim();
    if (draft.busy) {
      return;
    }
    if (!name) {
      this._renameDraft = { ...draft, error: "Le nom est obligatoire." };
      return;
    }
    this._renameDraft = { ...draft, busy: true, error: null };
    try {
      await this.hass.connection.sendMessagePromise({
        type: "heatwise/rename_room",
        room_id: room.room_id,
        name,
      });
      this._renameDraft = { ...this._renameDraft, value: name, dirty: false, busy: false };
      await this._loadRooms();
    } catch (err) {
      this._renameDraft = {
        ...this._renameDraft,
        busy: false,
        error: err.message || "Une erreur est survenue.",
      };
      if (err.code === "room_not_found") {
        await this._loadRooms();
      }
    }
  }

  // --- Supprimer une pièce (spec 009, US2) ---

  _askRoomDeletion(room) {
    this._roomDeletion = { room, busy: false, error: null };
  }

  _cancelRoomDeletion() {
    this._roomDeletion = null;
  }

  async _confirmRoomDeletion() {
    const deletion = this._roomDeletion;
    if (deletion.busy) {
      return;
    }
    this._roomDeletion = { ...deletion, busy: true, error: null };
    try {
      await this.hass.connection.sendMessagePromise({
        type: "heatwise/delete_room",
        room_id: deletion.room.room_id,
      });
      this._closeSettingsDialog();
      await this._loadRooms();
    } catch (err) {
      if (err.code === "room_not_found") {
        this._closeSettingsDialog();
        await this._loadRooms();
        return;
      }
      this._roomDeletion = {
        ...this._roomDeletion,
        busy: false,
        error: err.message || "Une erreur est survenue.",
      };
      if (err.code === "room_has_radiators" && this._settingsDialog) {
        await this._loadSettingsRadiators();
      }
    }
  }

  async _loadSettingsRadiators() {
    const { room } = this._settingsDialog;
    try {
      const response = await this.hass.connection.sendMessagePromise({
        type: "heatwise/list_radiators",
        room_id: room.room_id,
      });
      this._settingsDialog = {
        room,
        radiators: response.radiators,
        loading: false,
        error: null,
      };
    } catch (err) {
      this._settingsDialog = {
        room,
        radiators: [],
        loading: false,
        error: "Impossible de charger les radiateurs de cette pièce.",
      };
    }
  }

  async _toggleRadiatorHeating(radiator) {
    try {
      const response = await this.hass.connection.sendMessagePromise({
        type: "heatwise/set_radiator_heating",
        radiator_id: radiator.radiator_id,
        heating: !radiator.heating,
      });
      const radiators = this._settingsDialog.radiators.map((r) =>
        r.radiator_id === radiator.radiator_id ? response.radiator : r
      );
      this._settingsDialog = { ...this._settingsDialog, radiators, error: null };
    } catch (err) {
      // FR-018 : l'icône garde son état, seul un message d'erreur apparaît.
      this._settingsDialog = {
        ...this._settingsDialog,
        error: this._pairingErrorMessage(err),
      };
    }
  }

  // --- Suppression d'un radiateur (spec 004, US1) ---

  _askRadiatorDeletion(radiator) {
    this._radiatorDeletion = { radiator, step: "confirm", busy: false, error: null };
  }

  _cancelRadiatorDeletion() {
    this._radiatorDeletion = null;
  }

  async _confirmRadiatorDeletion(force = false) {
    if (this._radiatorDeletion.busy) {
      return;
    }
    const { radiator } = this._radiatorDeletion;
    this._radiatorDeletion = { ...this._radiatorDeletion, busy: true, error: null };

    try {
      const response = await this.hass.connection.sendMessagePromise({
        type: "heatwise/delete_radiator",
        radiator_id: radiator.radiator_id,
        force,
      });
      this._radiatorDeletion = null;
      await this._loadRooms();
      await this._reloadSettingsRadiators();
      if (response.radio_sent === false) {
        const notice =
          "Le récepteur reste associé au dongle : dissociez-le manuellement sur le récepteur.";
        if (this._settingsDialog) {
          this._settingsDialog = { ...this._settingsDialog, error: notice };
        } else {
          // Radiateur sans pièce (spec 009) : pas de fenêtre de pièce
          // ouverte, l'avertissement reste dans la fenêtre de suppression.
          this._radiatorDeletion = { radiator, step: "notice", busy: false, error: notice };
        }
      }
      return;
    } catch (err) {
      if (err.code === "rfplayer_unreachable" || err.code === "rfplayer_not_configured") {
        this._radiatorDeletion = {
          ...this._radiatorDeletion,
          step: "unreachable",
          busy: false,
          error: this._pairingErrorMessage(err),
        };
        await this._reloadSettingsRadiators();
        return;
      }
      if (err.code === "radiator_not_found") {
        this._radiatorDeletion = null;
        await this._loadRooms();
        await this._reloadSettingsRadiators();
        return;
      }
      this._radiatorDeletion = {
        ...this._radiatorDeletion,
        busy: false,
        error: this._pairingErrorMessage(err),
      };
    }
  }

  // La fenêtre de la pièce n'est pas ouverte quand on supprime un
  // radiateur sans pièce depuis l'encart de la vue principale (spec 009).
  async _reloadSettingsRadiators() {
    if (this._settingsDialog) {
      await this._loadSettingsRadiators();
    }
  }

  _openCreateDialog() {
    this._createDialogOpen = true;
    this._createName = "";
    this._createError = null;
  }

  _closeCreateDialog() {
    this._createDialogOpen = false;
  }

  _onCreateNameInput(event) {
    this._createName = event.target.value;
    this._createError = null;
  }

  async _submitCreateRoom() {
    const name = this._createName.trim();
    if (!name) {
      this._createError = "Le nom est obligatoire.";
      return;
    }

    try {
      const response = await this.hass.connection.sendMessagePromise({
        type: "heatwise/create_room",
        name,
      });
      this._rooms = [...this._rooms, response.room];
      this._createDialogOpen = false;
    } catch (err) {
      if (err.code === "invalid_name" || err.code === "name_taken") {
        this._createError = err.message;
      } else {
        throw err;
      }
    }
  }

  // --- Sonde d'une pièce (spec 006) ---

  // État d'affichage de la sonde (data-model.md, « État d'affichage ») :
  // none | missing | unavailable | stale | pending | ok.
  _sensorStatusFor(room) {
    const status = { status: "none", temperature: null, humidity: null, since: null, battery: null };
    if (!room.has_sensor) {
      return status;
    }
    const state = this.hass.states[room.temperature_entity_id];
    const batteryState = room.battery_entity_id && this.hass.states[room.battery_entity_id];
    if (batteryState && isNumeric(batteryState.state)) {
      status.battery = Number(batteryState.state);
    }
    const humidityState = room.humidity_entity_id && this.hass.states[room.humidity_entity_id];
    if (humidityState && isNumeric(humidityState.state)) {
      status.humidity = humidityState.state;
    }
    if (room.sensor_missing || !state) {
      return { ...status, status: "missing" };
    }
    if (state.state === "unavailable") {
      return { ...status, status: "unavailable", since: state.last_changed };
    }
    // `sensor_stale` est rafraîchi chaque minute ; une valeur reçue en
    // direct depuis le dernier rechargement lève l'indicateur aussitôt.
    if (
      room.sensor_stale &&
      Date.parse(state.last_updated) <= Date.parse(room.temperature_last_reported)
    ) {
      return { ...status, status: "stale", since: room.temperature_last_reported };
    }
    if (!isNumeric(state.state)) {
      return { ...status, status: "pending" };
    }
    return { ...status, status: "ok", temperature: state.state };
  }

  _roomById(roomId) {
    return this._rooms.find((room) => room.room_id === roomId);
  }

  _replaceRoom(room) {
    this._rooms = this._rooms.map((r) => (r.room_id === room.room_id ? room : r));
  }

  _sensorErrorMessage(err) {
    switch (err.code) {
      case "room_not_found":
        return "Cette pièce n'existe plus.";
      case "sensor_not_found":
        return "Ce capteur de température n'existe plus dans Home Assistant.";
      case "humidity_not_found":
        return "Ce capteur d'humidité n'existe plus dans Home Assistant.";
      case "sensor_already_used":
      case "humidity_already_used":
        return err.message;
      default:
        return "L'opération a échoué. Réessayez.";
    }
  }

  async _openSensorDialog(room) {
    this._sensorDialog = {
      room,
      sensors: [],
      loading: true,
      error: null,
      query: "",
      temperatureId: room.temperature_entity_id || null,
      humidityId: room.humidity_entity_id || null,
      busy: false,
    };
    try {
      const response = await this.hass.connection.sendMessagePromise({
        type: "heatwise/list_sensors",
      });
      this._sensorDialog = {
        ...this._sensorDialog,
        sensors: response.sensors,
        pairingAvailable: response.pairing_available === true,
        loading: false,
      };
    } catch (err) {
      this._sensorDialog = {
        ...this._sensorDialog,
        loading: false,
        error: "Impossible de charger les capteurs de Home Assistant.",
      };
    }
  }

  _closeSensorDialog() {
    this._stopSensorPairing();
    this._sensorDialog = null;
  }

  // --- Appairage d'une sonde Zigbee (spec 007) ---

  async _startSensorPairing() {
    this._stopSensorPairing();
    const { room } = this._sensorDialog;
    const pairing = { finished: false };
    this._pairingSession = pairing;
    this._sensorPairing = { step: "starting", endsAt: null, notice: null, event: null, error: null };
    try {
      const unsub = await this.hass.connection.subscribeMessage(
        (event) => this._onSensorPairingEvent(pairing, event),
        { type: "heatwise/pair_sensor", room_id: room.room_id },
        // Une reconnexion ne doit pas rouvrir le réseau à l'insu de
        // l'utilisateur : la perte de connexion est signalée à la place.
        { resubscribe: false }
      );
      if (this._pairingSession !== pairing || pairing.finished) {
        // Fenêtre fermée (ou session finie) pendant l'ouverture.
        this._safeUnsubscribe(unsub);
        return;
      }
      this._pairingUnsub = unsub;
      this._pairingDisconnectListener = () => this._onSensorPairingDisconnected(pairing);
      this.hass.connection.addEventListener("disconnected", this._pairingDisconnectListener);
    } catch (err) {
      if (this._pairingSession !== pairing) {
        return;
      }
      pairing.finished = true;
      const error =
        err && err.code === "room_not_found"
          ? this._sensorErrorMessage(err)
          : (err && err.message) || "Impossible d'ouvrir l'appairage Zigbee.";
      this._sensorPairing = { ...this._sensorPairing, step: "error", error };
    }
  }

  _onSensorPairingEvent(pairing, event) {
    if (this._pairingSession !== pairing || pairing.finished) {
      return;
    }
    const current = this._sensorPairing;
    switch (event.type) {
      case "waiting":
        this._sensorPairing = { ...current, step: "waiting", endsAt: Date.parse(event.ends_at) };
        this._pairingNow = Date.now();
        clearInterval(this._pairingTimer);
        this._pairingTimer = setInterval(() => (this._pairingNow = Date.now()), 1000);
        return;
      case "detected":
        this._sensorPairing = { ...current, step: "detected" };
        return;
      case "repairing":
        this._sensorPairing = { ...current, step: "repairing", event };
        return;
      case "not_a_sensor":
        if (!event.final) {
          this._sensorPairing = {
            ...current,
            step: current.step === "detected" ? "waiting" : current.step,
            notice: event.entities_missing
              ? `« ${event.device_name} » a rejoint le réseau, mais Home Assistant n'a pas créé ses capteurs, même après rechargement de Zigbee. Redémarrez Home Assistant, puis associez la sonde depuis la liste. L'attente continue pour une autre sonde.`
              : `« ${event.device_name} » a rejoint le réseau mais ne mesure pas la température : il reste dans Home Assistant, sans être associé. L'attente continue.`,
          };
          return;
        }
        break;
      case "associated":
        this._loadRooms();
        break;
      case "association_failed":
      case "config_timeout":
      case "timeout":
        break;
      default:
        return;
    }
    // Événement final : la session est terminée côté serveur.
    pairing.finished = true;
    this._releaseSensorPairing();
    this._sensorPairing = { ...current, step: event.type, event };
  }

  _onSensorPairingDisconnected(pairing) {
    if (this._pairingSession !== pairing || pairing.finished) {
      return;
    }
    pairing.finished = true;
    this._releaseSensorPairing();
    this._sensorPairing = { ...this._sensorPairing, step: "lost" };
  }

  _safeUnsubscribe(unsub) {
    try {
      Promise.resolve(unsub()).catch(() => {});
    } catch (err) {
      // Connexion déjà fermée : le serveur a arrêté la session.
    }
  }

  // Libère l'abonnement, la minuterie et l'écoute de déconnexion, sans
  // changer l'étape affichée.
  _releaseSensorPairing() {
    if (this._pairingUnsub) {
      this._safeUnsubscribe(this._pairingUnsub);
      this._pairingUnsub = null;
    }
    clearInterval(this._pairingTimer);
    this._pairingTimer = null;
    if (this._pairingDisconnectListener && this.hass) {
      this.hass.connection.removeEventListener("disconnected", this._pairingDisconnectListener);
    }
    this._pairingDisconnectListener = null;
  }

  // « Arrêter », fermeture, Échap, sortie du panneau (FR-005).
  _stopSensorPairing() {
    if (this._pairingSession) {
      this._pairingSession.finished = true;
    }
    this._pairingSession = null;
    this._releaseSensorPairing();
    this._sensorPairing = null;
  }

  // Retour à la liste, rechargée : une sonde appairée mais non associée
  // y figure désormais.
  _backToSensorList() {
    const { room } = this._sensorDialog;
    this._stopSensorPairing();
    this._openSensorDialog(room);
  }

  _isTakenElsewhere(sensor, room) {
    return sensor.used_by_room_id !== null && sensor.used_by_room_id !== room.room_id;
  }

  _selectTemperatureSensor(entityId) {
    const { sensors, room } = this._sensorDialog;
    const chosen = sensors.find((s) => s.entity_id === entityId);
    // Humidité du même appareil d'abord, sinon celle déjà associée à la
    // pièce (cas limite de la spec).
    const sameDevice =
      chosen && chosen.device_id
        ? sensors.find(
            (s) =>
              s.kind === "humidity" &&
              s.device_id === chosen.device_id &&
              !this._isTakenElsewhere(s, room)
          )
        : null;
    this._sensorDialog = {
      ...this._sensorDialog,
      temperatureId: entityId,
      humidityId: sameDevice ? sameDevice.entity_id : room.humidity_entity_id || null,
      error: null,
    };
  }

  _selectHumiditySensor(event) {
    this._sensorDialog = { ...this._sensorDialog, humidityId: event.target.value || null };
  }

  async _saveSensorDialog() {
    const { room, temperatureId, humidityId, busy } = this._sensorDialog;
    if (busy || !temperatureId) {
      return;
    }
    this._sensorDialog = { ...this._sensorDialog, busy: true, error: null };
    try {
      const response = await this.hass.connection.sendMessagePromise({
        type: "heatwise/set_room_sensor",
        room_id: room.room_id,
        temperature_entity_id: temperatureId,
        humidity_entity_id: humidityId,
      });
      this._replaceRoom(response.room);
      this._sensorDialog = null;
    } catch (err) {
      this._sensorDialog = {
        ...this._sensorDialog,
        busy: false,
        error: this._sensorErrorMessage(err),
      };
    }
  }

  _askSensorDissociation(room) {
    this._sensorDissociation = { room, busy: false, error: null };
  }

  _cancelSensorDissociation() {
    this._sensorDissociation = null;
  }

  async _confirmSensorDissociation() {
    const { room, busy } = this._sensorDissociation;
    if (busy) {
      return;
    }
    this._sensorDissociation = { ...this._sensorDissociation, busy: true, error: null };
    try {
      const response = await this.hass.connection.sendMessagePromise({
        type: "heatwise/clear_room_sensor",
        room_id: room.room_id,
      });
      this._replaceRoom(response.room);
      this._sensorDissociation = null;
    } catch (err) {
      this._sensorDissociation = {
        ...this._sensorDissociation,
        busy: false,
        error: this._sensorErrorMessage(err),
      };
    }
  }

  render() {
    if (this._houseHistory) {
      return html`
        <heatwise-house-history
          .hass=${this.hass}
          .rooms=${this._rooms}
          @close=${this._closeHouseHistory}
        ></heatwise-house-history>
      `;
    }
    if (this._historyRoom) {
      return html`
        <heatwise-history
          .hass=${this.hass}
          .roomId=${this._historyRoom.room_id}
          .roomName=${this._historyRoom.name}
          @close=${this._closeHistoryView}
        ></heatwise-history>
      `;
    }

    if (this._scheduleRoom) {
      return html`
        <heatwise-schedule
          .hass=${this.hass}
          .roomId=${this._scheduleRoom.room_id}
          .roomName=${this._scheduleRoom.name}
          .rooms=${this._rooms}
          .narrow=${this.narrow}
          @close=${this._closeScheduleView}
        ></heatwise-schedule>
      `;
    }

    return html`
      <div class="rooms-view">
        <header class="hw-header">
          <div class="hw-title">
            <ha-icon icon="mdi:radiator"></ha-icon>
            <h1>Heatwise</h1>
            ${this._info && this._info.version
              ? html`<button
                  class="version-chip"
                  title="Version installée — vérifier les mises à jour"
                  aria-label="Version ${normalizeVersion(this._info.version)}, vérifier les mises à jour"
                  ?disabled=${this._checkingUpdate}
                  @click=${() => this._checkForUpdate(true)}
                >
                  v${normalizeVersion(this._info.version)}${this._checkingUpdate ? " …" : ""}
                </button>`
              : ""}
          </div>
          <div class="header-actions">
          <div class="view-toggle">
            <button
              class="view-toggle-button ${this._viewMode === "grid" ? "active" : ""}"
              aria-label="Affichage en pavés"
              @click=${() => this._setViewMode("grid")}
            >
              <ha-icon icon="mdi:view-grid-outline"></ha-icon>
            </button>
            <button
              class="view-toggle-button ${this._viewMode === "list" ? "active" : ""}"
              aria-label="Affichage en liste"
              @click=${() => this._setViewMode("list")}
            >
              <ha-icon icon="mdi:view-list-outline"></ha-icon>
            </button>
          </div>
            ${this._outdoor
              ? html`<span class="outdoor-chip" title="Température extérieure">
                  <ha-icon icon="mdi:thermometer"></ha-icon>
                  <span class="label">Extérieur</span>
                  ${this._outdoor.temperature === null
                    ? "—"
                    : `${formatMeasuredTemperature(this._outdoor.temperature)} °C`}
                </span>`
              : ""}
            <button
              class="toolbar-button"
              aria-label="Historique de toutes les pièces"
              title="Historique de toutes les pièces"
              @click=${this._openHouseHistory}
            >
              <ha-icon icon="mdi:chart-line"></ha-icon>
              <span class="label">Historique</span>
            </button>
            <button
              class="toolbar-button ${this._generalSettings.vacation_mode ? "active" : ""}"
              aria-label="Mode vacances"
              title="Mode vacances"
              @click=${this._toggleVacationMode}
            >
              <ha-icon icon="mdi:beach"></ha-icon>
              <span class="label">Mode vacances</span>
            </button>
            <button
              class="toolbar-button"
              aria-label="Paramètres Heatwise"
              title="Paramètres Heatwise"
              @click=${this._openGeneralSettingsDialog}
            >
              <ha-icon icon="mdi:cog"></ha-icon>
            </button>
            <button class="button-primary" @click=${this._openCreateDialog}>
              <ha-icon icon="mdi:plus"></ha-icon>
              Créer une pièce
            </button>
          </div>
        </header>

        ${this._renderUpdateBanner()}

        ${this._generalSettings.vacation_mode
          ? html`<div class="vacation-banner">
              <ha-icon icon="mdi:beach"></ha-icon>
              Mode vacances actif — les pièces suivent leur programmation
              Vacances.
            </div>`
          : ""}

        ${this._rooms.length ? this._renderRooms() : html`<p class="hint">Aucune pièce pour l'instant.</p>`}
        ${this._orphanRadiators.length ? this._renderOrphanRadiators() : ""}
      </div>

      ${this._createDialogOpen ? this._renderCreateDialog() : ""}
      ${this._settingsDialog ? this._renderSettingsDialog() : ""}
      ${this._roomDeletion ? this._renderRoomDeletionDialog() : ""}
      ${this._sensorDialog ? this._renderSensorDialog() : ""}
      ${this._sensorDissociation ? this._renderSensorDissociationDialog() : ""}
      ${this._radiatorDeletion ? this._renderRadiatorDeletionDialog() : ""}
      ${this._pairing ? this._renderPairingDialog() : ""}
      ${this._generalSettingsDialog ? this._renderGeneralSettingsDialog() : ""}
      ${this._updateDialog ? this._renderUpdateDialog() : ""}
      ${this._temporaryDialog ? this._renderTemporaryDialog() : ""}
    `;
  }

  // Spec 011 (US3, FR-013 à FR-015) : bandeau de mise à jour sous l'en-tête.
  _renderUpdateBanner() {
    if (this._updateError) {
      return html`
        <div class="update-banner alert" role="alert">
          <ha-icon icon="mdi:alert-outline"></ha-icon>
          <span class="grow">${this._updateError}</span>
          <button class="icon-button" aria-label="Fermer" @click=${() => (this._updateError = null)}>
            <ha-icon icon="mdi:close"></ha-icon>
          </button>
        </div>
      `;
    }
    const status = this._updateStatus();
    if (this._updateNotice && (!status || status.kind === "none")) {
      return html`
        <div class="update-banner" role="status">
          <ha-icon icon="mdi:information-outline"></ha-icon>
          <span class="grow">${this._updateNotice}</span>
          <button class="icon-button" aria-label="Fermer" @click=${() => (this._updateNotice = null)}>
            <ha-icon icon="mdi:close"></ha-icon>
          </button>
        </div>
      `;
    }
    if (!status) {
      return "";
    }
    switch (status.kind) {
      case "available":
        return html`
          <div class="update-banner">
            <ha-icon icon="mdi:package-up"></ha-icon>
            <span class="grow">Mise à jour <strong>${status.latest}</strong> disponible.</span>
            ${status.releaseUrl
              ? html`<a href=${status.releaseUrl} target="_blank" rel="noopener noreferrer">
                  Notes de version
                </a>`
              : ""}
            <button class="button-primary small" @click=${this._askUpdate}>Mettre à jour</button>
          </div>
        `;
      case "installing":
        return html`
          <div class="update-banner">
            <ha-icon icon="mdi:progress-download"></ha-icon>
            <span class="grow">
              Installation de la version ${status.latest}…${status.progress != null
                ? ` ${Math.round(status.progress)} %`
                : ""}
            </span>
          </div>
        `;
      case "restart":
        return html`
          <div class="update-banner">
            <ha-icon icon="mdi:restart"></ha-icon>
            <span class="grow">
              Version ${status.installed} installée : redémarrez Home Assistant
              pour l'appliquer.
            </span>
            <button class="button-primary small" @click=${this._askRestart}>Redémarrer</button>
          </div>
        `;
      default:
        return "";
    }
  }

  _renderUpdateDialog() {
    const { step, status } = this._updateDialog;
    const install = step === "install";
    return html`
      <div class="dialog-overlay">
        <div class="dialog">
          <div class="dialog-header">
            <h2>${install ? `Mettre à jour vers ${status.latest}` : "Redémarrer Home Assistant"}</h2>
            <button class="icon-button" aria-label="Fermer" @click=${this._closeUpdateDialog}>
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
          </div>
          <p class="hint">
            ${install
              ? html`Heatwise ${status.version} sera remplacé par la version
                  ${status.latest} via HACS, puis Home Assistant redémarrera
                  automatiquement : tous les radiateurs repartiront à l'arrêt
                  puis la régulation reprendra. La page se rechargera d'elle-même.`
              : html`Home Assistant va redémarrer pour appliquer la nouvelle
                  version de Heatwise. Tous les radiateurs repartiront à l'arrêt
                  puis la régulation reprendra.`}
          </p>
          <div class="dialog-actions">
            <button class="button-secondary" @click=${this._closeUpdateDialog}>Annuler</button>
            <button class="button-primary" @click=${this._confirmUpdateDialog}>
              ${install ? "Mettre à jour et redémarrer" : "Redémarrer"}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  _renderGeneralSettingsDialog() {
    const { defaultTemperature, historyInterval, outdoorEntityId, error } =
      this._generalSettingsDialog;
    const sources = this._outdoorSources;
    const missing = outdoorEntityId && !sources.some((s) => s.entity_id === outdoorEntityId);
    const sourceLabel = (source) => {
      const value =
        source.temperature === null || source.temperature === undefined
          ? ""
          : ` — ${formatMeasuredTemperature(source.temperature)} °C`;
      const room = source.room_id ? this._roomById(source.room_id) : null;
      return `${source.name}${value}${room ? ` (sonde de ${room.name})` : ""}`;
    };
    return html`
      <div class="dialog-overlay">
        <div class="dialog">
          <div class="dialog-header">
            <h2>Paramètres Heatwise</h2>
            <button
              class="icon-button"
              aria-label="Fermer"
              @click=${this._closeGeneralSettingsDialog}
            >
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
          </div>
          <div>
            <label for="hw-default-temperature">Consigne hors plage (°C)</label>
            <input
              id="hw-default-temperature"
              type="number"
              min="7"
              max="25"
              step="0.5"
              .value=${defaultTemperature}
              @input=${this._onDefaultTemperatureInput}
            />
            <label for="hw-history-interval">
              Fréquence d'enregistrement de l'historique (minutes)
            </label>
            <input
              id="hw-history-interval"
              type="number"
              min="1"
              max="60"
              step="1"
              .value=${historyInterval}
              @input=${this._onHistoryIntervalInput}
            />
            <label for="hw-outdoor-source">Température extérieure</label>
            <select
              id="hw-outdoor-source"
              class="outdoor-source"
              @change=${this._onOutdoorSourceChange}
            >
              <option value="" ?selected=${!outdoorEntityId}>Aucune</option>
              ${missing
                ? html`<option value=${outdoorEntityId} selected>
                    ${outdoorEntityId} (introuvable)
                  </option>`
                : ""}
              ${sources.map(
                (source) => html`<option
                  value=${source.entity_id}
                  ?selected=${source.entity_id === outdoorEntityId}
                >
                  ${source.kind === "weather" ? "Météo : " : ""}${sourceLabel(source)}
                </option>`
              )}
            </select>
            <p class="hint">
              Enregistrée dans l'historique uniquement ; sans effet sur la régulation.
            </p>
            ${error ? html`<p class="dialog-error">${error}</p>` : ""}
          </div>
          <div class="dialog-actions">
            <button class="button-secondary" @click=${this._closeGeneralSettingsDialog}>
              Annuler
            </button>
            <button class="button-primary" @click=${this._saveGeneralSettings}>
              Enregistrer
            </button>
          </div>
        </div>
      </div>
    `;
  }

  _renderRooms() {
    if (this._viewMode === "list") {
      return html`
        <div class="room-list">${this._rooms.map((room) => this._renderRoomRow(room))}</div>
      `;
    }
    return html`
      <div class="rooms">${this._rooms.map((room) => this._renderRoomCard(room))}</div>
    `;
  }

  _renderSettingsDialog() {
    const { radiators, loading, error } = this._settingsDialog;
    // Lue à jour : la sonde peut changer pendant que la fenêtre est ouverte.
    const room = this._roomById(this._settingsDialog.room.room_id) || this._settingsDialog.room;
    return html`
      <div class="dialog-overlay">
        <div class="dialog">
          <div class="dialog-header">
            <div>
              <h2>Paramètres</h2>
              <span class="dialog-subtitle">— ${room.name}</span>
            </div>
            <button
              class="icon-button"
              aria-label="Fermer"
              @click=${this._closeSettingsDialog}
            >
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
          </div>

          ${this._renderRenameSection(room)}

          ${this._renderSensorSection(room)}

          <div class="section-header">
            <h3 class="section-title">Radiateurs</h3>
            <button
              class="icon-button add-radiator"
              aria-label="Ajouter un radiateur"
              title="Ajouter un radiateur"
              @click=${() => this._startRadiatorPairing(room)}
            >
              <ha-icon icon="mdi:plus"></ha-icon>
              <ha-icon icon="mdi:radiator"></ha-icon>
            </button>
          </div>
          ${error ? html`<p class="dialog-error">${error}</p>` : ""}
          ${loading
            ? html`<p class="hint">Chargement…</p>`
            : radiators.length
              ? html`<div class="radiator-list">
                  ${radiators.map((radiator) => this._renderRadiatorRow(radiator))}
                </div>`
              : html`<p class="hint">Aucun radiateur pour cette pièce.</p>`}

          <div class="room-deletion-footer">
            <button
              class="button-danger"
              ?disabled=${loading}
              @click=${() => this._askRoomDeletion(room)}
            >
              Supprimer la pièce
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // Section « Pièce » des paramètres : renommage (spec 009, US1). Tant
  // que le champ n'a pas été modifié, il suit le nom courant (renommage
  // fait ailleurs pendant que la fenêtre est ouverte).
  _renderRenameSection(room) {
    const draft = this._renameDraft || { value: room.name, dirty: false, busy: false, error: null };
    const value = draft.dirty ? draft.value : room.name;
    const unchanged = value.trim() === room.name;
    return html`
      <div class="section-header">
        <h3 class="section-title">Pièce</h3>
      </div>
      <div>
        <label for="hw-room-rename">Nom</label>
        <div class="rename-row">
          <input
            id="hw-room-rename"
            type="text"
            .value=${value}
            @input=${this._onRenameInput}
            @keydown=${(event) => {
              if (event.key === "Enter" && value.trim() && !unchanged) {
                this._submitRename(room);
              }
            }}
          />
          <button
            class="button-secondary"
            ?disabled=${draft.busy || !value.trim() || unchanged}
            @click=${() => this._submitRename(room)}
          >
            Renommer
          </button>
        </div>
        ${draft.error ? html`<p class="dialog-error">${draft.error}</p>` : ""}
      </div>
      <div>
        <button class="pill-button history" @click=${() => this._openHistoryView(room)}>
          <ha-icon icon="mdi:chart-line"></ha-icon>
          Historique
        </button>
      </div>
    `;
  }

  // Confirmation de suppression d'une pièce (spec 009, US2) : refusée
  // tant qu'il reste des radiateurs (FR-008) ; aucun ordre radio.
  _renderRoomDeletionDialog() {
    const { busy, error } = this._roomDeletion;
    const room = this._roomById(this._roomDeletion.room.room_id) || this._roomDeletion.room;
    const radiators = (this._settingsDialog && this._settingsDialog.radiators) || [];
    const sensorState = room.has_sensor && this.hass.states[room.temperature_entity_id];
    const sensorName =
      (sensorState && sensorState.attributes.friendly_name) || room.temperature_entity_id;
    return html`
      <div class="dialog-overlay">
        <div class="dialog">
          <div class="dialog-header">
            <div>
              <h2>Supprimer la pièce</h2>
              <span class="dialog-subtitle">— ${room.name}</span>
            </div>
            <button
              class="icon-button"
              aria-label="Fermer"
              @click=${this._cancelRoomDeletion}
            >
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
          </div>
          ${radiators.length
            ? html`<p class="hint">
                  Cette pièce a encore des radiateurs. Supprimez-les d'abord
                  depuis ses paramètres :
                  ${radiators.map((r) => r.name).join(", ")}.
                </p>
                ${error ? html`<p class="dialog-error">${error}</p>` : ""}
                <div class="dialog-actions">
                  <button class="button-secondary" @click=${this._cancelRoomDeletion}>
                    Fermer
                  </button>
                </div>`
            : html`<p class="hint">
                  « ${room.name} » sera supprimée du panneau et de
                  Home Assistant (Paramètres → Zones).
                </p>
                <ul class="hint deletion-summary">
                  <li>Sa programmation sera effacée.</li>
                  <li>
                    Son historique sera conservé mais ne sera plus
                    consultable.
                  </li>
                  ${room.has_sensor
                    ? html`<li>
                        La sonde « ${sensorName} » reste dans Home Assistant,
                        sans zone.
                      </li>`
                    : ""}
                </ul>
                ${error ? html`<p class="dialog-error">${error}</p>` : ""}
                <div class="dialog-actions">
                  <button
                    class="button-secondary"
                    ?disabled=${busy}
                    @click=${this._cancelRoomDeletion}
                  >
                    Annuler
                  </button>
                  <button
                    class="button-danger filled"
                    ?disabled=${busy}
                    @click=${this._confirmRoomDeletion}
                  >
                    Supprimer
                  </button>
                </div>`}
        </div>
      </div>
    `;
  }

  // Encart « Radiateurs sans pièce » (spec 009, US3) : radiateurs dont
  // la zone a été supprimée hors du panneau, arrêtés par la régulation ;
  // seule action : la suppression (arrêt puis dissociation, spec 004).
  _renderOrphanRadiators() {
    return html`
      <div class="orphan-section">
        <h3 class="section-title">Radiateurs sans pièce</h3>
        <p class="hint">
          Leur pièce a été supprimée. Ils sont à l'arrêt ; supprimez-les
          pour les dissocier du dongle.
        </p>
        <div class="radiator-list">
          ${this._orphanRadiators.map(
            (radiator) => html`
              <div class="radiator-row">
                <button
                  class="icon-button radiator-delete"
                  aria-label="Supprimer ${radiator.name}"
                  title="Supprimer ${radiator.name}"
                  @click=${() => this._askRadiatorDeletion(radiator)}
                >
                  <ha-icon icon="mdi:trash-can-outline"></ha-icon>
                </button>
                <span class="radiator-name">${radiator.name}</span>
              </div>
            `
          )}
        </div>
      </div>
    `;
  }

  // Section « Sonde » des paramètres d'une pièce (spec 006, US4). Le
  // titre est mis en majuscules par `.section-title`.
  _renderSensorSection(room) {
    const header = html`
      <div class="section-header">
        <h3 class="section-title">Sonde</h3>
        ${room.has_sensor
          ? ""
          : html`<button
              class="icon-button add-radiator"
              aria-label="Associer une sonde"
              title="Associer une sonde"
              @click=${() => this._openSensorDialog(room)}
            >
              <ha-icon icon="mdi:plus"></ha-icon>
              <ha-icon icon="mdi:thermometer"></ha-icon>
            </button>`}
      </div>
    `;
    if (!room.has_sensor) {
      return html`${header}<p class="hint">Aucune sonde.</p>`;
    }

    const { status, temperature, humidity, since, battery } = this._sensorStatusFor(room);
    const state = this.hass.states[room.temperature_entity_id];
    const name = (state && state.attributes.friendly_name) || room.temperature_entity_id;
    let detail;
    switch (status) {
      case "missing":
        detail = "Sonde introuvable dans Home Assistant";
        break;
      case "unavailable":
        detail = `Indisponible${since ? ` depuis ${formatMoment(since)}` : ""}`;
        break;
      case "stale":
        detail = `Indisponible — ${formatLastMeasure(since)}`;
        break;
      case "pending":
        detail = "En attente de mesure";
        break;
      default:
        detail = [
          `${formatMeasuredTemperature(temperature)} °C`,
          humidity !== null ? formatHumidity(humidity) : null,
        ]
          .filter(Boolean)
          .join(" · ");
    }

    return html`
      ${header}
      <div class="sensor-summary">
        <div class="sensor-summary-text">
          <span class="sensor-name">${name}</span>
          <span class="sensor-detail">${detail}</span>
          ${battery !== null
            ? html`<span class="sensor-detail ${battery <= LOW_BATTERY_THRESHOLD ? "low-battery" : ""}">
                Pile : ${battery} %
              </span>`
            : ""}
        </div>
        <div class="sensor-actions">
          <button class="button-secondary" @click=${() => this._openSensorDialog(room)}>
            Changer
          </button>
          <button class="button-secondary" @click=${() => this._askSensorDissociation(room)}>
            Dissocier
          </button>
        </div>
      </div>
    `;
  }

  _renderSensorDialog() {
    if (this._sensorPairing) {
      return this._renderSensorPairingDialog();
    }
    const {
      room,
      sensors,
      loading,
      error,
      query,
      temperatureId,
      humidityId,
      busy,
      pairingAvailable,
    } = this._sensorDialog;
    const needle = normalizeSearch(query);
    const matches = (sensor) =>
      !needle ||
      normalizeSearch(sensor.name).includes(needle) ||
      normalizeSearch(sensor.area_name).includes(needle);
    const temperatures = sensors
      .filter((s) => s.kind === "temperature" && matches(s))
      .sort((a, b) => {
        const aHere = a.area_id === room.room_id ? 0 : 1;
        const bHere = b.area_id === room.room_id ? 0 : 1;
        return aHere - bHere || a.name.localeCompare(b.name, "fr");
      });
    const humidities = sensors.filter((s) => s.kind === "humidity");
    const hasTemperatureSensors = sensors.some((s) => s.kind === "temperature");
    // FR-002 : l'appairage devient l'action principale quand aucune
    // sonde libre n'est proposée.
    const hasFreeTemperatureSensor = sensors.some(
      (s) => s.kind === "temperature" && !this._isTakenElsewhere(s, room)
    );
    const pairingFirst = pairingAvailable && !hasFreeTemperatureSensor;

    let body;
    if (loading) {
      body = html`<p class="hint">Chargement…</p>`;
    } else if (!hasTemperatureSensors) {
      body = pairingAvailable
        ? html`<p class="hint">
            Aucun capteur de température dans Home Assistant. Appairez une
            nouvelle sonde ci-dessous.
          </p>`
        : html`<p class="hint">
            Aucun capteur de température dans Home Assistant. Appairez d'abord la
            sonde (ZHA → Ajouter un appareil).
          </p>`;
    } else {
      body = html`
        <input
          type="search"
          placeholder="Rechercher un capteur ou une zone"
          aria-label="Rechercher un capteur ou une zone"
          .value=${query}
          @input=${(e) => (this._sensorDialog = { ...this._sensorDialog, query: e.target.value })}
        />
        <div class="sensor-list" role="radiogroup" aria-label="Capteurs de température">
          ${temperatures.length
            ? temperatures.map((sensor) => this._renderSensorChoice(sensor, room, temperatureId))
            : html`<p class="hint">Aucun capteur ne correspond.</p>`}
        </div>
        ${temperatureId
          ? html`
              <div>
                <label for="hw-humidity-sensor">Humidité</label>
                <select id="hw-humidity-sensor" @change=${this._selectHumiditySensor}>
                  <option value="" ?selected=${!humidityId}>Aucune</option>
                  ${humidities.map((sensor) => {
                    const taken = this._isTakenElsewhere(sensor, room);
                    return html`<option
                      value=${sensor.entity_id}
                      ?selected=${sensor.entity_id === humidityId}
                      ?disabled=${taken}
                    >
                      ${sensor.name}${isNumeric(sensor.state) ? ` — ${formatHumidity(sensor.state)}` : ""}${taken
                        ? ` (déjà associée à ${sensor.used_by_room_name})`
                        : ""}
                    </option>`;
                  })}
                </select>
              </div>
            `
          : ""}
      `;
    }

    const pairingButton =
      !loading && pairingAvailable
        ? html`
            <button
              class="${pairingFirst ? "button-primary" : "button-secondary"} pairing-start"
              ?disabled=${busy}
              @click=${this._startSensorPairing}
            >
              <ha-icon icon="mdi:zigbee"></ha-icon>
              Appairer une nouvelle sonde
            </button>
          `
        : "";

    return this._renderSensorDialogFrame(
      "Associer une sonde",
      room,
      html`
        ${body}
        ${pairingButton}
        ${error ? html`<p class="dialog-error">${error}</p>` : ""}
        <div class="dialog-actions">
          <button class="button-secondary" ?disabled=${busy} @click=${this._closeSensorDialog}>
            Annuler
          </button>
          ${pairingFirst && !temperatureId
            ? ""
            : html`<button
                class="button-primary"
                ?disabled=${busy || !temperatureId}
                @click=${this._saveSensorDialog}
              >
                Associer
              </button>`}
        </div>
      `
    );
  }

  _renderSensorDialogFrame(title, room, content) {
    return html`
      <div
        class="dialog-overlay"
        @click=${(e) => e.target === e.currentTarget && this._closeSensorDialog()}
      >
        <div class="dialog sensor-dialog">
          <div class="dialog-header">
            <div>
              <h2>${title}</h2>
              <span class="dialog-subtitle">— ${room.name}</span>
            </div>
            <button class="icon-button" aria-label="Fermer" @click=${this._closeSensorDialog}>
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
          </div>
          ${content}
        </div>
      </div>
    `;
  }

  _formatCountdown(endsAt) {
    const remaining = Math.max(0, Math.ceil((endsAt - this._pairingNow) / 1000));
    const minutes = Math.floor(remaining / 60);
    const seconds = String(remaining % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
  }

  _renderPairingMeasure(entityId, format, unit) {
    const state = entityId ? this.hass.states[entityId] : null;
    if (!state || !isNumeric(state.state)) {
      return html`<span class="pairing-measure pending">en attente de la première mesure</span>`;
    }
    return html`<span class="pairing-measure">${format(state.state)}${unit}</span>`;
  }

  _renderSensorPairingDialog() {
    const { room } = this._sensorDialog;
    const { step, endsAt, notice, event, error } = this._sensorPairing;
    const stop = html`<button class="button-secondary" @click=${this._backToSensorList}>
      Arrêter
    </button>`;
    const back = html`<button class="button-secondary" @click=${this._backToSensorList}>
      Retour
    </button>`;
    const retry = html`<button class="button-primary" @click=${this._startSensorPairing}>
      Réessayer
    </button>`;
    const noticeBlock = notice ? html`<p class="pairing-notice">${notice}</p>` : "";

    let content;
    switch (step) {
      case "starting":
        content = html`
          <p class="hint">Ouverture du réseau Zigbee…</p>
          <div class="dialog-actions">${stop}</div>
        `;
        break;
      case "waiting":
        content = html`
          <ol class="pairing-steps">
            <li>Mettez la pile dans la sonde et rapprochez-la du coordinateur Zigbee.</li>
            <li>
              Maintenez le bouton de la sonde environ 5 secondes, jusqu'à ce que
              l'icône réseau de l'écran clignote.
            </li>
            <li>
              Relâchez et n'appuyez plus : la configuration peut prendre
              jusqu'à une minute, gardez la sonde près du coordinateur.
            </li>
          </ol>
          <p class="pairing-countdown" aria-live="polite">
            ${endsAt ? this._formatCountdown(endsAt) : ""}
            <span class="hint">avant la fin de l'appairage</span>
          </p>
          ${noticeBlock}
          <div class="dialog-actions">${stop}</div>
        `;
        break;
      case "detected":
        content = html`
          <p class="pairing-status">
            <ha-icon icon="mdi:access-point-network"></ha-icon>
            Sonde détectée, configuration en cours…
          </p>
          <p class="hint">Gardez la sonde près du coordinateur jusqu'à la fin.</p>
          ${noticeBlock}
          <div class="dialog-actions">${stop}</div>
        `;
        break;
      case "repairing":
        content = html`
          <p class="pairing-status">
            <ha-icon icon="mdi:access-point-network"></ha-icon>
            Finalisation de la configuration…
          </p>
          <p class="hint">
            Home Assistant n'a pas encore créé les capteurs de « ${event.device_name} » :
            Heatwise recharge l'intégration Zigbee. Les appareils Zigbee sont
            indisponibles quelques secondes.
          </p>
          <div class="dialog-actions">${stop}</div>
        `;
        break;
      case "associated":
        content = html`
          <p class="pairing-status success">
            <ha-icon icon="mdi:check-circle"></ha-icon>
            « ${event.device_name} » est associée à ${room.name}.
          </p>
          <div class="pairing-measures">
            <span>
              Température :
              ${this._renderPairingMeasure(
                event.temperature_entity_id,
                formatMeasuredTemperature,
                " °C"
              )}
            </span>
            ${event.humidity_entity_id
              ? html`<span>
                  Humidité :
                  ${this._renderPairingMeasure(event.humidity_entity_id, formatHumidity, "")}
                </span>`
              : ""}
          </div>
          ${event.other_devices.length
            ? html`<p class="hint">
                Autre(s) appareil(s) ayant rejoint le réseau, non associé(s) :
                ${event.other_devices.join(", ")}.
              </p>`
            : ""}
          <div class="dialog-actions">
            <button class="button-primary" @click=${this._closeSensorDialog}>Fermer</button>
          </div>
        `;
        break;
      case "timeout":
        content = html`
          <p class="pairing-status">Aucune sonde détectée.</p>
          <ul class="hint pairing-causes">
            <li>bouton maintenu trop peu longtemps (l'icône réseau doit clignoter) ;</li>
            <li>sonde trop éloignée du coordinateur Zigbee ;</li>
            <li>pile faible ou mal insérée.</li>
          </ul>
          <div class="dialog-actions">${back}${retry}</div>
        `;
        break;
      case "not_a_sensor":
        content = event.entities_missing
          ? html`
              <p class="pairing-status">
                « ${event.device_name} » est appairée, mais Home Assistant n'a pas
                créé ses capteurs, même après rechargement de Zigbee.
              </p>
              <p class="hint">
                Redémarrez Home Assistant : ses capteurs de température et
                d'humidité seront créés. Associez-la ensuite depuis la liste
                « Associer une sonde » ; inutile de l'appairer à nouveau.
              </p>
              <div class="dialog-actions">${back}</div>
            `
          : html`
              <p class="pairing-status">
                « ${event.device_name} » a été ajouté à Home Assistant mais ne
                mesure pas la température.
              </p>
              <p class="hint">Rien n'a été associé ; l'appareil reste dans Home Assistant.</p>
              <div class="dialog-actions">${back}${retry}</div>
            `;
        break;
      case "config_timeout":
        content = html`
          <p class="pairing-status">La configuration de l'appareil n'a pas abouti.</p>
          <p class="hint">
            Vérifiez l'appareil dans Home Assistant (ZHA), ou réinitialisez la
            sonde et réessayez.
          </p>
          <div class="dialog-actions">${back}${retry}</div>
        `;
        break;
      case "association_failed":
        content = html`
          <p class="dialog-error">${this._sensorErrorMessage(event)}</p>
          <p class="hint">
            « ${event.device_name} » est appairée mais n'a pas été associée à
            ${room.name}.
          </p>
          <div class="dialog-actions">${back}</div>
        `;
        break;
      case "lost":
        content = html`
          <p class="dialog-error">
            La connexion avec Home Assistant a été perdue pendant l'appairage.
            Rien n'a été associé.
          </p>
          <div class="dialog-actions">${back}${retry}</div>
        `;
        break;
      default: // "error"
        content = html`
          <p class="dialog-error">${error}</p>
          <div class="dialog-actions">${back}</div>
        `;
    }
    return this._renderSensorDialogFrame("Appairer une sonde", room, content);
  }

  _renderSensorChoice(sensor, room, selectedId) {
    const taken = this._isTakenElsewhere(sensor, room);
    const selected = sensor.entity_id === selectedId;
    const value = isNumeric(sensor.state)
      ? `${formatMeasuredTemperature(sensor.state)} °C`
      : "indisponible";
    return html`
      <button
        class="sensor-choice ${selected ? "selected" : ""}"
        role="radio"
        aria-checked=${selected ? "true" : "false"}
        ?disabled=${taken}
        @click=${() => this._selectTemperatureSensor(sensor.entity_id)}
      >
        <ha-icon icon=${selected ? "mdi:radiobox-marked" : "mdi:radiobox-blank"}></ha-icon>
        <span class="sensor-choice-text">
          <span class="sensor-name">${sensor.name}</span>
          <span class="sensor-detail">
            ${value}${sensor.area_name ? ` · ${sensor.area_name}` : ""}${taken
              ? ` · déjà associée à ${sensor.used_by_room_name}`
              : ""}
          </span>
        </span>
      </button>
    `;
  }

  _renderSensorDissociationDialog() {
    const { room, busy, error } = this._sensorDissociation;
    return html`
      <div class="dialog-overlay">
        <div class="dialog">
          <div class="dialog-header">
            <div>
              <h2>Dissocier la sonde</h2>
              <span class="dialog-subtitle">— ${room.name}</span>
            </div>
            <button class="icon-button" aria-label="Fermer" @click=${this._cancelSensorDissociation}>
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
          </div>
          <p class="hint">
            Dissocier la sonde de ${room.name} ? La température et l'humidité
            ne seront plus affichées.
          </p>
          ${error ? html`<p class="dialog-error">${error}</p>` : ""}
          <div class="dialog-actions">
            <button class="button-secondary" ?disabled=${busy} @click=${this._cancelSensorDissociation}>
              Annuler
            </button>
            <button class="button-primary" ?disabled=${busy} @click=${this._confirmSensorDissociation}>
              Dissocier
            </button>
          </div>
        </div>
      </div>
    `;
  }

  _renderRadiatorRow(radiator) {
    return html`
      <div class="radiator-row">
        <button
          class="icon-button radiator-delete"
          aria-label="Supprimer ${radiator.name}"
          title="Supprimer ${radiator.name}"
          ?disabled=${!!this._pairing}
          @click=${() => this._askRadiatorDeletion(radiator)}
        >
          <ha-icon icon="mdi:trash-can-outline"></ha-icon>
        </button>
        <button
          class="icon-button radiator-toggle ${radiator.heating ? "heating" : ""}"
          aria-label=${radiator.heating ? "Éteindre le radiateur" : "Allumer le radiateur"}
          @click=${() => this._toggleRadiatorHeating(radiator)}
        >
          <ha-icon icon=${radiator.heating ? "mdi:radiator" : "mdi:radiator-off"}></ha-icon>
        </button>
        <span class="radiator-name">${radiator.name}</span>
      </div>
    `;
  }

  _renderRadiatorDeletionDialog() {
    const { radiator, step, busy, error } = this._radiatorDeletion;

    if (step === "notice") {
      return html`
        <div class="dialog-overlay">
          <div class="dialog">
            <div class="dialog-header">
              <div>
                <h2>Radiateur supprimé</h2>
                <span class="dialog-subtitle">— ${radiator.name}</span>
              </div>
            </div>
            <p class="hint">${error}</p>
            <div class="dialog-actions">
              <button class="button-primary" @click=${this._cancelRadiatorDeletion}>
                OK
              </button>
            </div>
          </div>
        </div>
      `;
    }

    if (step === "unreachable") {
      return html`
        <div class="dialog-overlay">
          <div class="dialog">
            <div class="dialog-header">
              <div>
                <h2>Suppression impossible</h2>
                <span class="dialog-subtitle">— ${radiator.name}</span>
              </div>
              <button
                class="icon-button"
                aria-label="Fermer"
                @click=${this._cancelRadiatorDeletion}
              >
                <ha-icon icon="mdi:close"></ha-icon>
              </button>
            </div>
            ${error ? html`<p class="dialog-error">${error}</p>` : ""}
            <p class="hint">
              Vous pouvez le supprimer quand même du panneau ; son récepteur
              restera alors associé au dongle et devra être dissocié
              manuellement. S'il chauffait, il peut continuer jusqu'à une
              heure (coupure de sécurité du récepteur).
            </p>
            <div class="dialog-actions">
              <button
                class="button-secondary"
                ?disabled=${busy}
                @click=${this._cancelRadiatorDeletion}
              >
                Annuler
              </button>
              <button
                class="button-primary"
                ?disabled=${busy}
                @click=${() => this._confirmRadiatorDeletion(true)}
              >
                Supprimer quand même
              </button>
            </div>
          </div>
        </div>
      `;
    }

    return html`
      <div class="dialog-overlay">
        <div class="dialog">
          <div class="dialog-header">
            <div>
              <h2>Supprimer le radiateur</h2>
              <span class="dialog-subtitle">— ${radiator.name}</span>
            </div>
            <button
              class="icon-button"
              aria-label="Fermer"
              @click=${this._cancelRadiatorDeletion}
            >
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
          </div>
          <p class="hint">
            « ${radiator.name} » sera éteint puis dissocié du dongle. Il
            faudra l'appairer de nouveau pour le piloter avec Heatwise.
          </p>
          ${error ? html`<p class="dialog-error">${error}</p>` : ""}
          <div class="dialog-actions">
            <button
              class="button-secondary"
              ?disabled=${busy}
              @click=${this._cancelRadiatorDeletion}
            >
              Annuler
            </button>
            <button
              class="button-primary"
              ?disabled=${busy}
              @click=${() => this._confirmRadiatorDeletion(false)}
            >
              Supprimer
            </button>
          </div>
        </div>
      </div>
    `;
  }

  _renderPairingDialog() {
    const { room, step, error } = this._pairing;
    const busy = step === "sending" || step === "confirming";

    if (step === "name") {
      return html`
        <div class="dialog-overlay">
          <div class="dialog">
            <h2>Nommer le radiateur</h2>
            <div>
              <label for="hw-radiator-name">Nom du radiateur</label>
              <input
                id="hw-radiator-name"
                type="text"
                .value=${this._pairing.name}
                @input=${this._onPairingNameInput}
              />
              ${error ? html`<p class="dialog-error">${error}</p>` : ""}
            </div>
            <div class="dialog-actions">
              <button class="button-secondary" @click=${this._abandonPairing}>
                Abandonner
              </button>
              <button class="button-primary" @click=${this._savePairing}>
                Enregistrer
              </button>
            </div>
          </div>
        </div>
      `;
    }

    if (step === "waiting" || step === "confirming") {
      return html`
        <div class="dialog-overlay">
          <div class="dialog">
            <div class="dialog-header">
              <div>
                <h2>Vérifiez l'appairage</h2>
                <span class="dialog-subtitle">— ${room.name}</span>
              </div>
            </div>
            <p class="hint">
              Le voyant TH du récepteur est-il passé au vert fixe ?
            </p>
            ${error ? html`<p class="dialog-error">${error}</p>` : ""}
            <div class="dialog-actions">
              <button
                class="button-secondary"
                ?disabled=${busy}
                @click=${this._abandonPairing}
              >
                Abandonner
              </button>
              <button
                class="button-secondary"
                ?disabled=${busy}
                @click=${this._retryPairing}
              >
                Réessayer
              </button>
              <button
                class="button-primary"
                ?disabled=${busy}
                @click=${this._confirmPairingSuccess}
              >
                Appairage réussi
              </button>
            </div>
          </div>
        </div>
      `;
    }

    // step === "intro" ou "sending"
    return html`
      <div class="dialog-overlay">
        <div class="dialog">
          <div class="dialog-header">
            <div>
              <h2>Ajouter un radiateur</h2>
              <span class="dialog-subtitle">— ${room.name}</span>
            </div>
          </div>
          <p class="hint">
            Mettez le récepteur du radiateur en attente d'appairage par un
            appui bref : le voyant TH doit clignoter en vert (un voyant jaune
            signale la voie AUX, à éviter : recommencez avec un appui plus
            court). Cliquez ensuite sur « C'est fait ». Ce radiateur
            s'ajoutera à ceux déjà présents dans ${room.name}.
          </p>
          <p class="hint">
            Si un thermostat (par exemple Delta Dore) pilote actuellement ce
            radiateur, il sera remplacé par Heatwise et ne le pilotera plus.
          </p>
          ${error ? html`<p class="dialog-error">${error}</p>` : ""}
          <div class="dialog-actions">
            <button
              class="button-secondary"
              ?disabled=${busy}
              @click=${this._cancelPairingIntro}
            >
              Abandonner
            </button>
            <button
              class="button-primary"
              ?disabled=${busy}
              @click=${this._confirmPairingStart}
            >
              C'est fait
            </button>
          </div>
        </div>
      </div>
    `;
  }

  _renderCreateDialog() {
    return html`
      <div class="dialog-overlay">
        <div class="dialog">
          <h2>Créer une pièce</h2>
          <div>
            <label for="hw-room-name">Nom de la pièce</label>
            <input
              id="hw-room-name"
              type="text"
              placeholder="ex. Bureau"
              .value=${this._createName}
              @input=${this._onCreateNameInput}
            />
            ${this._createError
              ? html`<p class="dialog-error">${this._createError}</p>`
              : ""}
          </div>
          <div class="dialog-actions">
            <button class="button-secondary" @click=${this._closeCreateDialog}>
              Annuler
            </button>
            <button class="button-primary" @click=${this._submitCreateRoom}>
              Créer
            </button>
          </div>
        </div>
      </div>
    `;
  }

  _renderRoomIdentity(room) {
    return html`
      <div class="room-icon">
        <ha-icon icon=${room.icon || "mdi:home-outline"}></ha-icon>
      </div>
      <span class="room-name">${room.name}</span>
    `;
  }

  _renderRoomHeader(room) {
    return html`
      <div class="room-header">
        ${this._renderRoomIdentity(room)}
        ${this._renderRoomActions(room)}
      </div>
    `;
  }

  _renderRoomActions(room) {
    return html`
      <div class="room-actions">
        <button
          class="icon-button"
          aria-label="Historique"
          title="Historique"
          @click=${() => this._openHistoryView(room)}
        >
          <ha-icon icon="mdi:chart-line"></ha-icon>
        </button>
        <button
          class="icon-button"
          aria-label="Programmation"
          title="Programmation"
          @click=${() => this._openScheduleView(room)}
        >
          <ha-icon icon="mdi:calendar"></ha-icon>
        </button>
        <button
          class="icon-button"
          aria-label="Paramètres de la pièce"
          @click=${() => this._openSettingsDialog(room)}
        >
          <ha-icon icon="mdi:cog-outline"></ha-icon>
        </button>
      </div>
    `;
  }

  _renderBatteryAlert(battery) {
    if (battery === null || battery > LOW_BATTERY_THRESHOLD) {
      return "";
    }
    const label = `Pile faible : ${battery} %`;
    return html`
      <span class="battery-alert" title=${label} aria-label=${label} role="img">
        <ha-icon icon="mdi:battery-alert-variant-outline"></ha-icon>
      </span>
    `;
  }

  // Mesures de la sonde sur le pavé / la ligne (spec 006, US2 et US3).
  _renderMeasures(room) {
    const { status, temperature, humidity, since, battery } = this._sensorStatusFor(room);
    switch (status) {
      case "none":
        return html`
          <button class="pill-button sensor" @click=${() => this._openSensorDialog(room)}>
            <ha-icon icon="mdi:thermometer-plus"></ha-icon>
            Thermomètre
          </button>
        `;
      case "missing":
        return html`<span class="unavailable">Sonde introuvable</span>`;
      case "unavailable":
        return html`
          <span class="unavailable">
            Sonde indisponible${since ? ` depuis ${formatMoment(since)}` : ""}
          </span>
        `;
      case "stale":
        return html`
          <span class="unavailable">
            Sonde indisponible — ${formatLastMeasure(since)}
          </span>
        `;
      case "pending":
        return html`<span class="current-temperature">—</span>`;
      default:
        return html`
          <span class="current-temperature">${formatMeasuredTemperature(temperature)}°</span>
        `;
    }
  }

  // Spec 011 (FR-018a) : humidité et pile, secondaires sous la mesure.
  _renderSecondaryMeasures(room) {
    const { status, humidity, battery } = this._sensorStatusFor(room);
    if (status === "none" || status === "missing") {
      return "";
    }
    const humidityPart =
      status !== "unavailable" && status !== "stale" && status !== "pending" && humidity !== null
        ? html`<span class="current-humidity">
            <ha-icon icon="mdi:water-percent"></ha-icon>${formatHumidity(humidity)}
          </span>`
        : "";
    const batteryPart = this._renderBatteryAlert(battery);
    if (!humidityPart && !batteryPart) {
      return "";
    }
    return html`<div class="measure-secondary">${humidityPart}${batteryPart}</div>`;
  }

  _renderTemperatureRow(room) {
    return html`
      <div class="measure-block">
        <div class="measure-main">
        ${this._renderMeasures(room)}
        ${room.has_radiator
          ? room.target_temperature != null
            ? this._renderTarget(room)
            : html`
                <span class="target-temperature-icon">
                  <ha-icon icon="mdi:radiator"></ha-icon>
                </span>
              `
          : html`
              <button
                class="pill-button radiator"
                @click=${() => this._startRadiatorPairing(room)}
              >
                <ha-icon icon="mdi:radiator"></ha-icon>
                Radiateur
              </button>
            `}
        </div>
        ${this._renderSecondaryMeasures(room)}
        ${this._renderRegulation(room)}
        ${this._renderTemporaryTarget(room)}
      </div>
    `;
  }

  // État de la régulation automatique sous les mesures (spec 008, FR-017).
  // Spec 011 (FR-018a) : puce colorée — libellé partagé avec
  // l'historique (heatwise-labels.js).
  _renderRegulation(room) {
    const label = room.regulation ? regulationLabel(room.regulation, room.heating) : null;
    if (!label) {
      return "";
    }
    return html`
      <span class="regulation-chip ${label.kind}" title=${label.text}>
        <ha-icon icon=${label.icon}></ha-icon>${label.text}
      </span>
    `;
  }

  // Spec 012 (FR-013b) : la consigne d'une pièce régulée ouvre le
  // dialogue de consigne temporaire.
  _renderTarget(room) {
    const temporary = !!temporaryTargetLabel(room.regulation);
    const content = html`<ha-icon icon=${temporary ? "mdi:timer-outline" : "mdi:target"}></ha-icon
      >${formatTargetTemperature(room.target_temperature)}°`;
    if (!room.has_sensor) {
      return html`<span class="target-temperature" title="Consigne courante">${content}</span>`;
    }
    return html`
      <button
        class="target-temperature ${temporary ? "temporary" : ""}"
        title="Consigne courante — consigne temporaire…"
        aria-label="Consigne temporaire"
        @click=${() => this._openTemporaryDialog(room)}
      >
        ${content}
      </button>
    `;
  }

  _renderTemporaryTarget(room) {
    const label = temporaryTargetLabel(room.regulation);
    if (!label) {
      return "";
    }
    return html`
      <span class="regulation-chip temporary" title=${label}>
        <ha-icon icon="mdi:timer-outline"></ha-icon>${label}
      </span>
    `;
  }

  _openTemporaryDialog(room) {
    const current = room.regulation && room.regulation.temporary_target;
    this._temporaryDialog = {
      roomId: room.room_id,
      temperature: String(current ? current.temperature : room.target_temperature ?? 19),
      duration: 120,
      error: null,
      busy: false,
    };
  }

  _closeTemporaryDialog() {
    this._temporaryDialog = null;
  }

  _temporaryErrorMessage(err) {
    return (
      {
        room_not_regulated: "Cette pièce n'a pas de sonde : elle ne peut pas suivre une température.",
        room_without_radiator: "Cette pièce n'a aucun radiateur.",
        vacation_mode_active: "Le mode vacances est actif : désactivez-le d'abord.",
        invalid_temperature: "Température entre 7 et 25 °C, par pas de 0,5.",
        invalid_duration: "Durée entre 30 min et 24 h.",
      }[err && err.code] || this._pairingErrorMessage(err || {})
    );
  }

  async _submitTemporaryDialog(clear) {
    const dialog = this._temporaryDialog;
    if (!dialog || dialog.busy) {
      return;
    }
    this._temporaryDialog = { ...dialog, busy: true, error: null };
    try {
      const response = await this.hass.connection.sendMessagePromise(
        clear
          ? { type: "heatwise/clear_temporary_target", room_id: dialog.roomId }
          : {
              type: "heatwise/set_temporary_target",
              room_id: dialog.roomId,
              temperature: Number(dialog.temperature),
              duration_minutes: Number(dialog.duration),
            }
      );
      this._rooms = this._rooms.map((r) => (r.room_id === dialog.roomId ? response.room : r));
      this._temporaryDialog = null;
    } catch (err) {
      this._temporaryDialog = { ...dialog, busy: false, error: this._temporaryErrorMessage(err) };
    }
  }

  _renderTemporaryDialog() {
    const dialog = this._temporaryDialog;
    const room = this._roomById(dialog.roomId);
    if (!room) {
      return "";
    }
    const active = !!temporaryTargetLabel(room.regulation);
    const durationLabel = (minutes) =>
      minutes < 60 ? `${minutes} min` : `${minutes / 60} h`;
    return html`
      <div class="dialog-overlay">
        <div class="dialog">
          <div class="dialog-header">
            <div>
              <h2>Consigne temporaire</h2>
              <span class="dialog-subtitle">— ${room.name}</span>
            </div>
            <button class="icon-button" aria-label="Fermer" @click=${this._closeTemporaryDialog}>
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
          </div>
          <p class="hint">
            ${active
              ? temporaryTargetLabel(room.regulation)
              : "La pièce suit cette consigne pendant la durée choisie, puis revient à sa programmation."}
          </p>
          <div>
            <label for="hw-temporary-temperature">Consigne (°C)</label>
            <input
              id="hw-temporary-temperature"
              type="number"
              min="7"
              max="25"
              step="0.5"
              .value=${dialog.temperature}
              @input=${(e) =>
                (this._temporaryDialog = { ...this._temporaryDialog, temperature: e.target.value })}
            />
            <label for="hw-temporary-duration">Durée</label>
            <select
              id="hw-temporary-duration"
              class="temporary-duration"
              @change=${(e) =>
                (this._temporaryDialog = { ...this._temporaryDialog, duration: e.target.value })}
            >
              ${TEMPORARY_DURATIONS.map(
                (minutes) => html`<option
                  value=${minutes}
                  ?selected=${Number(dialog.duration) === minutes}
                >
                  ${durationLabel(minutes)}
                </option>`
              )}
            </select>
            ${dialog.error ? html`<p class="dialog-error">${dialog.error}</p>` : ""}
          </div>
          <div class="dialog-actions">
            ${active
              ? html`<button
                  class="button-secondary"
                  ?disabled=${dialog.busy}
                  @click=${() => this._submitTemporaryDialog(true)}
                >
                  Revenir au planning
                </button>`
              : html`<button class="button-secondary" @click=${this._closeTemporaryDialog}>
                  Annuler
                </button>`}
            <button
              class="button-primary"
              ?disabled=${dialog.busy}
              @click=${() => this._submitTemporaryDialog(false)}
            >
              Appliquer
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // Spec 011 (US2, FR-005, FR-007) : « Chauffer 1 h » / « Arrêter la chauffe ».
  _renderRoomHeatingButton(room) {
    if (!room.has_radiator) {
      return "";
    }
    const manual = this._roomManualHeating(room);
    return html`
      <button
        class="heat-button ${manual ? "stop" : ""}"
        ?disabled=${!!this._roomHeatingBusy[room.room_id]}
        @click=${() => this._setRoomManualHeating(room, !manual)}
      >
        <ha-icon icon=${manual ? "mdi:fire-off" : "mdi:fire"}></ha-icon>
        ${manual ? "Arrêter la chauffe" : "Chauffer 1 h"}
      </button>
    `;
  }

  _renderRoomNotice(room) {
    const notice = this._roomNotices[room.room_id];
    return notice ? html`<span class="room-notice" role="alert">${notice}</span>` : "";
  }

  _roomStateClass(room) {
    if (this._roomManualHeating(room)) {
      return "manual";
    }
    return room.heating ? "heating" : "";
  }

  _renderRoomCard(room) {
    const button = this._renderRoomHeatingButton(room);
    const notice = this._renderRoomNotice(room);
    return html`
      <div class="room-card ${this._roomStateClass(room)}">
        ${this._renderRoomHeader(room)}
        ${this._renderTemperatureRow(room)}
        ${button || notice ? html`<div class="room-footer">${notice}${button}</div>` : ""}
      </div>
    `;
  }

  _renderRoomRow(room) {
    return html`
      <div class="room-row ${this._roomStateClass(room)}">
        <div class="room-identity">${this._renderRoomIdentity(room)}</div>
        ${this._renderTemperatureRow(room)}
        ${this._renderRoomNotice(room)}
        ${this._renderRoomHeatingButton(room)}
        ${this._renderRoomActions(room)}
      </div>
    `;
  }
}

customElements.define("heatwise-panel", HeatwisePanel);
