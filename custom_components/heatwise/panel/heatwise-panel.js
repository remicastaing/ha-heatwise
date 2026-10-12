import { LitElement, html, css } from "./vendor/lit-core.min.js";
import "./heatwise-schedule.js";

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

function formatHumidity(value) {
  return `${Math.round(Number(value))} %`;
}

function isNumeric(value) {
  return value !== null && value !== undefined && value !== "" && !Number.isNaN(Number(value));
}

// « 14:32 » si c'est aujourd'hui, « le 09/10 à 14:32 » sinon.
function formatMoment(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const time = date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) {
    return time;
  }
  const day = date.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
  return `le ${day} à ${time}`;
}

// « dernière mesure à 14:32 » / « dernière mesure le 09/10 à 14:32 ».
function formatLastMeasure(iso) {
  const moment = formatMoment(iso);
  return `dernière mesure ${moment.startsWith("le ") ? moment : `à ${moment}`}`;
}

// Spec 008 : libellé de l'état de régulation d'une pièce (contrat
// websocket-api.md). `kind` choisit le style : heating, idle, alert.
function regulationLabel(regulation) {
  const { status, reason, suspended_until: until } = regulation;
  switch (status) {
    case "heating":
      return { kind: "heating", icon: "mdi:fire", text: "Chauffe" };
    case "idle":
      return {
        kind: "idle",
        icon: "mdi:thermostat-auto",
        text: reason === "target_reached" ? "Consigne atteinte" : "Régulée",
      };
    case "safety_stop": {
      const why = {
        sensor_unavailable: "sonde indisponible",
        sensor_stale: "sonde muette",
        dongle_unreachable: "dongle injoignable",
      }[reason] || reason;
      return { kind: "alert", icon: "mdi:alert-outline", text: `Arrêt de sécurité : ${why}` };
    }
    case "suspended":
      return {
        kind: "idle",
        icon: "mdi:hand-back-right-outline",
        text: `Régulation suspendue (manuel)${until ? ` jusqu'à ${formatMoment(until)}` : ""}`,
      };
    case "not_regulated":
      return {
        kind: "idle",
        icon: "mdi:thermostat-off",
        text:
          reason === "rfplayer_not_configured"
            ? "Non régulée : dongle non configuré"
            : "Non régulée : pas de sonde",
      };
    default:
      return null;
  }
}

// Recherche insensible à la casse et aux accents.
function normalizeSearch(text) {
  return (text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
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
    _scheduleRoom: { state: true },
    _generalSettingsDialog: { state: true },
    _generalSettings: { state: true },
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

    heatwise-schedule {
      flex: 1;
      min-height: 0;
    }

    .hint {
      color: var(--hw-text-secondary);
      font-size: 14px;
    }

    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 18px;
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

    .temperature-row {
      display: flex;
      align-items: baseline;
      flex-wrap: wrap;
      gap: 8px;
    }

    .current-temperature {
      font-size: 28px;
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
      width: 160px;
      flex-shrink: 0;
    }

    .room-row .temperature-row {
      flex-grow: 1;
      margin: 0;
    }

    .room-row .current-temperature {
      font-size: 18px;
    }

    .regulation {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex-basis: 100%;
      font-size: 13px;
      color: var(--hw-text-secondary);
      --mdc-icon-size: 16px;
    }

    .regulation.heating {
      color: var(--hw-accent);
      font-weight: 600;
    }

    .regulation.alert {
      color: var(--error-color, #b3261e);
    }

    .room-row .regulation {
      flex-basis: auto;
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

    .sensor-dialog select {
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

    .toolbar-button.active {
      background: rgba(249, 115, 22, 0.12);
      border-color: rgba(249, 115, 22, 0.4);
      color: #9a4b0a;
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
    this._createError = false;
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
    this._generalSettingsDialog = null;
    this._generalSettings = { default_temperature: 16, vacation_mode: false };
    this._minuteTimer = null;
    this._unsubEvents = [];
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
  }

  _scheduleMinuteTick() {
    // FR-028/SC-008 : la consigne courante affichée sur les pavés suit
    // les frontières de plage au plus une minute après ; on ne pousse
    // pas d'entité HA dédiée cette itération (research.md R7).
    const delay = 60000 - (Date.now() % 60000);
    this._minuteTimer = setTimeout(() => {
      this._loadRooms();
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

  // --- Paramètres généraux et mode vacances (US4, US7) ---

  async _loadGeneralSettings() {
    try {
      const response = await this.hass.connection.sendMessagePromise({
        type: "heatwise/get_settings",
      });
      this._generalSettings = response.settings;
    } catch (err) {
      // Repli silencieux sur les valeurs par défaut déjà affichées.
    }
  }

  async _openGeneralSettingsDialog() {
    await this._loadGeneralSettings();
    this._generalSettingsDialog = {
      defaultTemperature: String(this._generalSettings.default_temperature),
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

  async _saveGeneralSettings() {
    const value = Number(this._generalSettingsDialog.defaultTemperature);
    if (Number.isNaN(value) || value < 7 || value > 25) {
      this._generalSettingsDialog = {
        ...this._generalSettingsDialog,
        error: "Entre 7 et 25 °C, par pas de 0,5.",
      };
      return;
    }
    try {
      const response = await this.hass.connection.sendMessagePromise({
        type: "heatwise/update_settings",
        default_temperature: value,
      });
      this._generalSettings = response.settings;
      this._generalSettingsDialog = null;
      await this._loadRooms();
    } catch (err) {
      this._generalSettingsDialog = {
        ...this._generalSettingsDialog,
        error: "Température invalide : entre 7 et 25 °C, par pas de 0,5.",
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
    await this._loadSettingsRadiators();
  }

  _closeSettingsDialog() {
    this._settingsDialog = null;
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
      await this._loadSettingsRadiators();
      if (response.radio_sent === false) {
        this._settingsDialog = {
          ...this._settingsDialog,
          error:
            "Le récepteur reste associé au dongle : dissociez-le manuellement sur le récepteur.",
        };
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
        await this._loadSettingsRadiators();
        return;
      }
      if (err.code === "radiator_not_found") {
        this._radiatorDeletion = null;
        await this._loadRooms();
        await this._loadSettingsRadiators();
        return;
      }
      this._radiatorDeletion = {
        ...this._radiatorDeletion,
        busy: false,
        error: this._pairingErrorMessage(err),
      };
    }
  }

  _openCreateDialog() {
    this._createDialogOpen = true;
    this._createName = "";
    this._createError = false;
  }

  _closeCreateDialog() {
    this._createDialogOpen = false;
  }

  _onCreateNameInput(event) {
    this._createName = event.target.value;
    this._createError = false;
  }

  async _submitCreateRoom() {
    const name = this._createName.trim();
    if (!name) {
      this._createError = true;
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
      if (err.code === "invalid_name") {
        this._createError = true;
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
        <div class="toolbar">
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
          <div class="header-actions">
            <button
              class="toolbar-button ${this._generalSettings.vacation_mode ? "active" : ""}"
              aria-label="Mode vacances"
              title="Mode vacances"
              @click=${this._toggleVacationMode}
            >
              <ha-icon icon="mdi:beach"></ha-icon>
              Mode vacances
            </button>
            <button
              class="toolbar-button"
              aria-label="Paramètres Heatwise"
              title="Paramètres Heatwise"
              @click=${this._openGeneralSettingsDialog}
            >
              <ha-icon icon="mdi:cog"></ha-icon>
            </button>
          </div>
          <button class="button-primary" @click=${this._openCreateDialog}>
            <ha-icon icon="mdi:plus"></ha-icon>
            Créer une pièce
          </button>
        </div>

        ${this._generalSettings.vacation_mode
          ? html`<div class="vacation-banner">
              <ha-icon icon="mdi:beach"></ha-icon>
              Mode vacances actif — les pièces suivent leur programmation
              Vacances.
            </div>`
          : ""}

        ${this._rooms.length ? this._renderRooms() : html`<p class="hint">Aucune pièce pour l'instant.</p>`}
      </div>

      ${this._createDialogOpen ? this._renderCreateDialog() : ""}
      ${this._settingsDialog ? this._renderSettingsDialog() : ""}
      ${this._sensorDialog ? this._renderSensorDialog() : ""}
      ${this._sensorDissociation ? this._renderSensorDissociationDialog() : ""}
      ${this._radiatorDeletion ? this._renderRadiatorDeletionDialog() : ""}
      ${this._pairing ? this._renderPairingDialog() : ""}
      ${this._generalSettingsDialog ? this._renderGeneralSettingsDialog() : ""}
    `;
  }

  _renderGeneralSettingsDialog() {
    const { defaultTemperature, error } = this._generalSettingsDialog;
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
              ? html`<p class="dialog-error">Le nom est obligatoire.</p>`
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

  _renderRoomHeader(room) {
    return html`
      <div class="room-header">
        <div class="room-icon">
          <ha-icon icon=${room.icon || "mdi:home-outline"}></ha-icon>
        </div>
        <span class="room-name">${room.name}</span>
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
          ${this._renderBatteryAlert(battery)}
        `;
      case "stale":
        return html`
          <span class="unavailable">
            Sonde indisponible — ${formatLastMeasure(since)}
          </span>
          ${this._renderBatteryAlert(battery)}
        `;
      case "pending":
        return html`
          <span class="current-temperature">—</span>
          ${this._renderBatteryAlert(battery)}
        `;
      default:
        return html`
          <span class="current-temperature">${formatMeasuredTemperature(temperature)}°</span>
          ${humidity !== null
            ? html`<span class="current-humidity">
                <ha-icon icon="mdi:water-percent"></ha-icon>${formatHumidity(humidity)}
              </span>`
            : ""}
          ${this._renderBatteryAlert(battery)}
        `;
    }
  }

  _renderTemperatureRow(room) {
    return html`
      <div class="temperature-row">
        ${this._renderMeasures(room)}
        ${room.has_radiator
          ? room.target_temperature != null
            ? html`<span class="target-temperature">(${formatTargetTemperature(room.target_temperature)}°)</span>`
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
        ${this._renderRegulation(room)}
      </div>
    `;
  }

  // État de la régulation automatique sous les mesures (spec 008, FR-017).
  _renderRegulation(room) {
    const label = room.regulation ? regulationLabel(room.regulation) : null;
    if (!label) {
      return "";
    }
    return html`
      <span class="regulation ${label.kind}">
        <ha-icon icon=${label.icon}></ha-icon>${label.text}
      </span>
    `;
  }

  _renderRoomCard(room) {
    return html`
      <div class="room-card">
        ${this._renderRoomHeader(room)}
        ${this._renderTemperatureRow(room)}
      </div>
    `;
  }

  _renderRoomRow(room) {
    return html`
      <div class="room-row">
        ${this._renderRoomHeader(room)}
        ${this._renderTemperatureRow(room)}
      </div>
    `;
  }
}

customElements.define("heatwise-panel", HeatwisePanel);
