import { LitElement, html, css } from "./vendor/lit-core.min.js";

// Ordre d'affichage samedi → vendredi (FR-002) ; les jours sont stockés
// comme `datetime.weekday()` (0 = lundi … 6 = dimanche), cf.
// `research.md` R2 et R9.
const DAY_ORDER = [5, 6, 0, 1, 2, 3, 4];
const DAY_LABELS = {
  0: "Lundi",
  1: "Mardi",
  2: "Mercredi",
  3: "Jeudi",
  4: "Vendredi",
  5: "Samedi",
  6: "Dimanche",
};
const WORKDAYS = [0, 1, 2, 3, 4];
const WEEKEND_DAYS = [5, 6];

const MIN_TEMPERATURE = 7;
const MAX_TEMPERATURE = 25;
const TEMPERATURE_STEP = 0.5;
const SLOT_STEP = 15;
const DAY_MINUTES = 1440;
const LONG_PRESS_MS = 400;
const MOVE_THRESHOLD_PX = 10;

// Dégradé bleu → rouge (research R11), jalons resserrés entre 14 et 21°C.
const GRADIENT_STOPS = [
  { t: 7, color: [30, 58, 138] },
  { t: 14, color: [96, 165, 250] },
  { t: 18, color: [251, 191, 36] },
  { t: 21, color: [249, 115, 22] },
  { t: 25, color: [220, 38, 38] },
];

export function temperatureToColor(temperature) {
  const t = Math.min(MAX_TEMPERATURE, Math.max(MIN_TEMPERATURE, temperature));
  let lower = GRADIENT_STOPS[0];
  let upper = GRADIENT_STOPS[GRADIENT_STOPS.length - 1];
  for (let i = 0; i < GRADIENT_STOPS.length - 1; i++) {
    if (t >= GRADIENT_STOPS[i].t && t <= GRADIENT_STOPS[i + 1].t) {
      lower = GRADIENT_STOPS[i];
      upper = GRADIENT_STOPS[i + 1];
      break;
    }
  }
  const span = upper.t - lower.t || 1;
  const ratio = (t - lower.t) / span;
  const rgb = lower.color.map((c, i) => Math.round(c + (upper.color[i] - c) * ratio));
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

export function textColorFor(rgbString) {
  const [r, g, b] = rgbString
    .slice(4, -1)
    .split(",")
    .map((n) => Number(n.trim()));
  // Luminance relative (WCAG, approximation sRGB simple suffisante ici).
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#1f1f1d" : "#ffffff";
}

function formatMinutes(minutes) {
  const clamped = Math.max(0, Math.min(DAY_MINUTES, minutes));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function formatTemperature(value) {
  return Number(value).toLocaleString("fr-FR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });
}

const TIME_OPTIONS = Array.from({ length: DAY_MINUTES / SLOT_STEP + 1 }, (_, i) => {
  const minutes = i * SLOT_STEP;
  return { minutes, label: formatMinutes(minutes) };
});

class HeatwiseSchedule extends LitElement {
  static properties = {
    hass: { attribute: false },
    roomId: { attribute: false },
    roomName: { attribute: false },
    rooms: { attribute: false },
    narrow: { type: Boolean },
    _schedule: { state: true },
    _settings: { state: true },
    _active: { state: true },
    _program: { state: true },
    _loading: { state: true },
    _error: { state: true },
    _selection: { state: true },
    _slotDialog: { state: true },
    _copyDayDialog: { state: true },
    _copyRoomDialog: { state: true },
    _parityKeepDialog: { state: true },
    _confirm: { state: true },
    _menuOpen: { state: true },
    _now: { state: true },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      box-sizing: border-box;
      --hw-bg: var(--primary-background-color, #f7f6f3);
      --hw-card: var(--card-background-color, #ffffff);
      --hw-border: var(--divider-color, #e5e3de);
      --hw-text: var(--primary-text-color, #1f1f1d);
      --hw-text-secondary: var(--secondary-text-color, #726f6a);
      --hw-accent: var(--primary-color, #0b84c4);
      --hw-accent-soft: rgba(11, 132, 196, 0.1);
      font-family: var(--paper-font-body1_-_font-family, inherit);
      color: var(--hw-text);
    }

    .header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding-bottom: 12px;
    }

    .header h2 {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 60vw;
    }

    .icon-button {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border: none;
      background: transparent;
      border-radius: 8px;
      color: var(--hw-text-secondary);
      cursor: pointer;
      --mdc-icon-size: 18px;
    }
    .icon-button:hover {
      background: var(--hw-border);
    }

    .toolbar {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      padding-bottom: 10px;
      position: relative;
    }

    .tabs {
      display: flex;
      gap: 4px;
      background: var(--hw-bg);
      border: 1px solid var(--hw-border);
      border-radius: 10px;
      padding: 3px;
    }

    .tab {
      border: none;
      background: transparent;
      padding: 6px 12px;
      border-radius: 7px;
      font-size: 13px;
      font-weight: 600;
      color: var(--hw-text-secondary);
      cursor: pointer;
    }
    .tab.active {
      background: var(--hw-accent-soft);
      color: var(--hw-accent);
    }

    .week-indicator {
      font-size: 12px;
      color: var(--hw-text-secondary);
    }

    .spacer {
      flex: 1;
    }

    .menu-wrapper {
      position: relative;
    }

    .menu {
      position: absolute;
      right: 0;
      top: 38px;
      background: var(--hw-card);
      border: 1px solid var(--hw-border);
      border-radius: 10px;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.18);
      display: flex;
      flex-direction: column;
      min-width: 240px;
      z-index: 20;
      overflow: hidden;
    }

    .menu button {
      border: none;
      background: transparent;
      text-align: left;
      padding: 10px 14px;
      font-size: 13px;
      color: var(--hw-text);
      cursor: pointer;
    }
    .menu button:hover {
      background: var(--hw-bg);
    }

    .vacation-banner {
      background: rgba(249, 115, 22, 0.12);
      color: #9a4b0a;
      border-radius: 10px;
      padding: 8px 14px;
      font-size: 13px;
      margin-bottom: 10px;
    }

    .legend {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 12px;
      color: var(--hw-text-secondary);
      margin-bottom: 10px;
    }

    .legend-gradient {
      flex: 1;
      max-width: 320px;
      height: 10px;
      border-radius: 5px;
      background: linear-gradient(
        to right,
        rgb(30, 58, 138),
        rgb(96, 165, 250) 30%,
        rgb(251, 191, 36) 55%,
        rgb(249, 115, 22) 70%,
        rgb(220, 38, 38)
      );
    }

    .schedule-wrapper {
      flex: 1;
      min-height: 0;
      overflow: auto;
      border: 1px solid var(--hw-border);
      border-radius: 12px;
      background: var(--hw-card);
    }

    .schedule-body {
      display: grid;
      grid-template-columns: 44px repeat(7, minmax(0, 1fr));
      height: 100%;
      min-height: 600px;
    }

    .narrow .schedule-body {
      grid-template-columns: 44px repeat(7, minmax(96px, 1fr));
      width: max-content;
      min-width: 100%;
    }

    .hours-column {
      position: relative;
      border-right: 1px solid var(--hw-border);
      position: sticky;
      left: 0;
      background: var(--hw-card);
      z-index: 2;
    }

    .hour-label {
      position: absolute;
      right: 4px;
      transform: translateY(-50%);
      font-size: 10px;
      color: var(--hw-text-secondary);
    }

    .day-column {
      position: relative;
      border-right: 1px solid var(--hw-border);
      touch-action: pan-y;
    }

    .day-column.today {
      background: rgba(11, 132, 196, 0.04);
    }

    .day-header {
      position: sticky;
      top: 0;
      background: var(--hw-card);
      border-bottom: 1px solid var(--hw-border);
      padding: 6px 4px;
      font-size: 12px;
      font-weight: 600;
      text-align: center;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      z-index: 1;
    }

    .day-header.today {
      color: var(--hw-accent);
    }

    .copy-day-button {
      --mdc-icon-size: 14px;
      width: 22px;
      height: 22px;
    }

    .hour-line {
      position: absolute;
      left: 0;
      right: 0;
      height: 1px;
      background: var(--hw-border);
    }

    .now-line {
      position: absolute;
      left: 0;
      right: 0;
      height: 2px;
      background: var(--hw-accent);
    }

    .schedule-slot {
      position: absolute;
      left: 2px;
      right: 2px;
      border-radius: 4px;
      font-size: 11px;
      padding: 2px 4px;
      overflow: hidden;
      cursor: pointer;
      box-sizing: border-box;
    }

    .selection-preview {
      position: absolute;
      left: 2px;
      right: 2px;
      border-radius: 4px;
      background: rgba(11, 132, 196, 0.35);
      border: 1px dashed var(--hw-accent);
      pointer-events: none;
    }

    .dialog-overlay {
      position: fixed;
      inset: 0;
      background: rgba(30, 28, 25, 0.38);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 30;
    }

    .dialog {
      width: 360px;
      max-width: calc(100vw - 32px);
      max-height: calc(100vh - 32px);
      overflow: auto;
      background: var(--hw-card);
      border-radius: 16px;
      padding: 24px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .dialog h2 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
    }

    .dialog label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 6px;
    }

    .dialog input,
    .dialog select {
      display: block;
      width: 100%;
      box-sizing: border-box;
      padding: 9px 10px;
      border: 1px solid var(--hw-border);
      border-radius: 9px;
      font-size: 14px;
      color: var(--hw-text);
    }

    .time-row {
      display: flex;
      gap: 10px;
    }
    .time-row > div {
      flex: 1;
    }

    .dialog-error {
      font-size: 12px;
      color: #b3261e;
    }

    .dialog-actions {
      display: flex;
      justify-content: flex-end;
      flex-wrap: wrap;
      gap: 10px;
    }

    .button-primary {
      padding: 9px 16px;
      background: var(--hw-accent);
      border: none;
      border-radius: 9px;
      color: #fff;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
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

    .button-danger {
      padding: 9px 16px;
      background: transparent;
      border: 1px solid rgba(179, 38, 30, 0.4);
      border-radius: 9px;
      color: #b3261e;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }

    .checkbox-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 260px;
      overflow: auto;
    }

    .checkbox-row {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
    }

    .shortcut-row {
      display: flex;
      gap: 8px;
    }

    .hint {
      font-size: 13px;
      color: var(--hw-text-secondary);
    }
  `;

  constructor() {
    super();
    this.rooms = [];
    this.narrow = false;
    this._schedule = null;
    this._settings = null;
    this._active = null;
    this._program = "all";
    this._loading = true;
    this._error = null;
    this._selection = null;
    this._slotDialog = null;
    this._copyDayDialog = null;
    this._copyRoomDialog = null;
    this._parityKeepDialog = null;
    this._confirm = null;
    this._menuOpen = false;
    this._now = new Date();
    this._pointerState = null;
    this._minuteTimer = null;
    this._unsubEvents = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._scheduleMinuteTick();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._minuteTimer) {
      clearTimeout(this._minuteTimer);
      this._minuteTimer = null;
    }
    if (this._unsubEvents) {
      this._unsubEvents();
      this._unsubEvents = null;
    }
  }

  _scheduleMinuteTick() {
    const delay = 60000 - (Date.now() % 60000);
    this._minuteTimer = setTimeout(() => {
      this._now = new Date();
      this._scheduleMinuteTick();
    }, delay);
  }

  updated(changedProps) {
    if (changedProps.has("hass") && this.hass && !this._unsubEvents) {
      this.hass.connection
        .subscribeEvents((event) => {
          const roomIds = event.data.room_ids;
          if (roomIds == null || roomIds.includes(this.roomId)) {
            this._loadSchedule();
          }
        }, "heatwise_schedule_updated")
        .then((unsub) => {
          this._unsubEvents = unsub;
        });
    }
    if (changedProps.has("roomId") && this.roomId) {
      this._loadSchedule();
    }
  }

  async _loadSchedule() {
    this._loading = true;
    try {
      const response = await this.hass.connection.sendMessagePromise({
        type: "heatwise/get_schedule",
        room_id: this.roomId,
      });
      this._schedule = response.schedule;
      this._settings = response.settings;
      this._active = response.active;
      if (!this._programExists(this._program)) {
        this._program = this._active.program;
      }
      this._error = null;
    } catch (err) {
      this._error = "Impossible de charger la programmation de cette pièce.";
    }
    this._loading = false;
  }

  _programExists(program) {
    if (!this._schedule) return false;
    if (program === "vacation") return true;
    return program in this._schedule.weeks;
  }

  _close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }

  _errorMessage(err) {
    switch (err && err.code) {
      case "room_not_found":
        return "Cette pièce n'existe plus.";
      case "program_not_found":
        return "Ce programme n'est pas disponible pour cette pièce.";
      case "invalid_slot":
        return "Horaires invalides (alignés au quart d'heure, dans une même journée).";
      case "invalid_temperature":
        return "Température invalide : entre 7 et 25 °C, par pas de 0,5.";
      case "invalid_copy":
        return "Cette copie n'est pas autorisée.";
      case "keep_required":
        return "Indiquez quelle semaine conserver.";
      case "invalid_format":
        return "Sélection invalide.";
      default:
        return "Une erreur est survenue.";
    }
  }

  async _sendMessage(message) {
    try {
      return await this.hass.connection.sendMessagePromise(message);
    } catch (err) {
      throw err;
    }
  }

  // --- Sélection par glisser (souris et toucher, research R10) ---

  _dayAndMinuteFromPoint(x, y) {
    const el = this.shadowRoot.elementFromPoint(x, y);
    const col = el && el.closest(".day-column");
    if (!col) return null;
    const day = Number(col.dataset.day);
    const rect = col.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (y - rect.top) / rect.height));
    const minute = Math.min(DAY_MINUTES, Math.round((fraction * DAY_MINUTES) / SLOT_STEP) * SLOT_STEP);
    return { day, minute };
  }

  _onGridPointerDown(event) {
    if (event.target.closest(".schedule-slot") || event.target.closest(".day-header")) {
      return; // Géré par _onSlotClick / le bouton « Copier ce jour ».
    }
    const point = this._dayAndMinuteFromPoint(event.clientX, event.clientY);
    if (!point) return;

    this._pointerState = {
      pointerId: event.pointerId,
      isTouch: event.pointerType === "touch",
      startX: event.clientX,
      startY: event.clientY,
      active: event.pointerType !== "touch",
      anchor: point,
      current: point,
      longPressTimer: null,
    };

    if (this._pointerState.isTouch) {
      this._pointerState.longPressTimer = setTimeout(() => {
        if (!this._pointerState) return;
        this._pointerState.active = true;
        event.target.setPointerCapture(event.pointerId);
        this._selection = { anchor: point, current: point };
      }, LONG_PRESS_MS);
    } else {
      event.target.setPointerCapture(event.pointerId);
      this._selection = { anchor: point, current: point };
    }
  }

  _onGridPointerMove(event) {
    const state = this._pointerState;
    if (!state || state.pointerId !== event.pointerId) return;

    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    const moved = Math.hypot(dx, dy) > MOVE_THRESHOLD_PX;

    if (!state.active) {
      if (state.isTouch && moved && state.longPressTimer) {
        // Glissé avant la fin de l'appui long : défilement natif.
        clearTimeout(state.longPressTimer);
        state.longPressTimer = null;
        this._pointerState = null;
      }
      return;
    }

    const point = this._dayAndMinuteFromPoint(event.clientX, event.clientY);
    if (!point) return;
    state.current = point;
    this._selection = { anchor: state.anchor, current: point };
  }

  _onGridPointerUp(event) {
    const state = this._pointerState;
    if (!state || state.pointerId !== event.pointerId) return;
    if (state.longPressTimer) {
      clearTimeout(state.longPressTimer);
    }
    this._pointerState = null;

    if (!state.active || !this._selection) {
      this._selection = null;
      return;
    }

    const { anchor, current } = this._selection;
    const posAnchor = DAY_ORDER.indexOf(anchor.day);
    const posCurrent = DAY_ORDER.indexOf(current.day);
    const [from, to] = posAnchor <= posCurrent ? [posAnchor, posCurrent] : [posCurrent, posAnchor];
    const days = DAY_ORDER.slice(from, to + 1);
    let start = Math.min(anchor.minute, current.minute);
    let end = Math.max(anchor.minute, current.minute);
    if (end === start) {
      end = Math.min(DAY_MINUTES, start + SLOT_STEP);
    }

    this._selection = null;
    this._slotDialog = {
      mode: "create",
      days,
      start,
      end,
      temperature: this._slotDialog ? this._slotDialog.temperature : 19,
      error: null,
    };
  }

  _selectionRectFor(day) {
    if (!this._selection) return null;
    const { anchor, current } = this._selection;
    const posAnchor = DAY_ORDER.indexOf(anchor.day);
    const posCurrent = DAY_ORDER.indexOf(current.day);
    const [from, to] = posAnchor <= posCurrent ? [posAnchor, posCurrent] : [posCurrent, posAnchor];
    const pos = DAY_ORDER.indexOf(day);
    if (pos < from || pos > to) return null;
    const start = Math.min(anchor.minute, current.minute);
    const end = Math.max(anchor.minute, current.minute);
    return { start, end: Math.max(end, start + SLOT_STEP) };
  }

  // --- Édition d'une plage existante (US1) ---

  _onSlotClick(day, slot) {
    this._slotDialog = {
      mode: "edit",
      days: [day],
      day,
      start: slot.start,
      end: slot.end,
      originalStart: slot.start,
      originalEnd: slot.end,
      temperature: slot.temperature,
      error: null,
    };
  }

  _closeSlotDialog() {
    this._slotDialog = null;
  }

  _onSlotTemperatureInput(event) {
    this._slotDialog = { ...this._slotDialog, temperature: event.target.value, error: null };
  }

  _onSlotStartInput(event) {
    this._slotDialog = { ...this._slotDialog, start: Number(event.target.value), error: null };
  }

  _onSlotEndInput(event) {
    this._slotDialog = { ...this._slotDialog, end: Number(event.target.value), error: null };
  }

  async _saveSlotDialog() {
    const dialog = this._slotDialog;
    const temperature = Number(dialog.temperature);
    if (
      Number.isNaN(temperature) ||
      temperature < MIN_TEMPERATURE ||
      temperature > MAX_TEMPERATURE
    ) {
      this._slotDialog = {
        ...dialog,
        error: `Température entre ${MIN_TEMPERATURE} et ${MAX_TEMPERATURE} °C, par pas de ${TEMPERATURE_STEP}.`,
      };
      return;
    }
    if (dialog.start >= dialog.end) {
      this._slotDialog = { ...dialog, error: "L'heure de fin doit suivre l'heure de début." };
      return;
    }

    let operations;
    if (dialog.mode === "edit") {
      operations = [];
      if (dialog.start !== dialog.originalStart || dialog.end !== dialog.originalEnd) {
        operations.push({
          day: dialog.day,
          start: dialog.originalStart,
          end: dialog.originalEnd,
          temperature: null,
        });
      }
      operations.push({ day: dialog.day, start: dialog.start, end: dialog.end, temperature });
    } else {
      operations = dialog.days.map((day) => ({
        day,
        start: dialog.start,
        end: dialog.end,
        temperature,
      }));
    }

    try {
      const response = await this._sendMessage({
        type: "heatwise/edit_schedule",
        room_id: this.roomId,
        program: this._program,
        operations,
      });
      this._schedule = response.schedule;
      this._slotDialog = null;
    } catch (err) {
      this._slotDialog = { ...dialog, error: this._errorMessage(err) };
    }
  }

  async _deleteSlot() {
    const dialog = this._slotDialog;
    try {
      const response = await this._sendMessage({
        type: "heatwise/edit_schedule",
        room_id: this.roomId,
        program: this._program,
        operations: [
          { day: dialog.day, start: dialog.originalStart, end: dialog.originalEnd, temperature: null },
        ],
      });
      this._schedule = response.schedule;
      this._slotDialog = null;
    } catch (err) {
      this._slotDialog = { ...dialog, error: this._errorMessage(err) };
    }
  }

  // --- Copie d'un jour (US5) ---

  _openCopyDayDialog(day) {
    this._menuOpen = false;
    this._copyDayDialog = { source: day, targets: new Set(), error: null };
  }

  _closeCopyDayDialog() {
    this._copyDayDialog = null;
  }

  _toggleCopyDayTarget(day) {
    const targets = new Set(this._copyDayDialog.targets);
    if (targets.has(day)) {
      targets.delete(day);
    } else {
      targets.add(day);
    }
    this._copyDayDialog = { ...this._copyDayDialog, targets };
  }

  _applyCopyDayShortcut(days) {
    const targets = new Set(days.filter((d) => d !== this._copyDayDialog.source));
    this._copyDayDialog = { ...this._copyDayDialog, targets };
  }

  _copyDayHasExistingPlages(day) {
    const week = this._currentWeek();
    return week && week[day] && week[day].length > 0;
  }

  async _confirmCopyDay() {
    const { source, targets } = this._copyDayDialog;
    if (targets.size === 0) return;
    try {
      const response = await this._sendMessage({
        type: "heatwise/copy_days",
        room_id: this.roomId,
        program: this._program,
        source_day: source,
        target_days: Array.from(targets),
      });
      this._schedule = response.schedule;
      this._copyDayDialog = null;
    } catch (err) {
      this._copyDayDialog = { ...this._copyDayDialog, error: this._errorMessage(err) };
    }
  }

  // --- Parité (US6) ---

  async _enableParity() {
    this._menuOpen = false;
    try {
      const response = await this._sendMessage({
        type: "heatwise/set_parity",
        room_id: this.roomId,
        enabled: true,
      });
      this._schedule = response.schedule;
      this._program = this._active.program === "vacation" ? "even" : this._active.program;
      if (!this._programExists(this._program)) {
        this._program = "even";
      }
    } catch (err) {
      this._error = this._errorMessage(err);
    }
  }

  _openParityKeepDialog() {
    this._menuOpen = false;
    const preferred = this._program === "odd" ? "odd" : "even";
    this._parityKeepDialog = { keep: preferred, error: null };
  }

  _closeParityKeepDialog() {
    this._parityKeepDialog = null;
  }

  _onKeepChoiceChange(event) {
    this._parityKeepDialog = { ...this._parityKeepDialog, keep: event.target.value };
  }

  async _confirmDisableParity() {
    const { keep } = this._parityKeepDialog;
    try {
      const response = await this._sendMessage({
        type: "heatwise/set_parity",
        room_id: this.roomId,
        enabled: false,
        keep,
      });
      this._schedule = response.schedule;
      this._program = "all";
      this._parityKeepDialog = null;
    } catch (err) {
      this._parityKeepDialog = { ...this._parityKeepDialog, error: this._errorMessage(err) };
    }
  }

  _askCopyParity(target) {
    this._menuOpen = false;
    const source = target === "odd" ? "even" : "odd";
    this._confirm = {
      message: `Remplacer la semaine ${target === "odd" ? "impaire" : "paire"} par une copie de la semaine ${
        target === "odd" ? "paire" : "impaire"
      } ?`,
      action: async () => {
        const response = await this._sendMessage({
          type: "heatwise/copy_program",
          room_id: this.roomId,
          source,
          target,
        });
        this._schedule = response.schedule;
      },
    };
  }

  _askCopyToVacation() {
    this._menuOpen = false;
    this._confirm = {
      message: "Remplacer la programmation Vacances par une copie de la semaine affichée ?",
      action: async () => {
        const response = await this._sendMessage({
          type: "heatwise/copy_program",
          room_id: this.roomId,
          source: this._program,
          target: "vacation",
        });
        this._schedule = response.schedule;
      },
    };
  }

  _closeConfirm() {
    this._confirm = null;
  }

  async _runConfirm() {
    const { action } = this._confirm;
    try {
      await action();
      this._confirm = null;
    } catch (err) {
      this._confirm = { ...this._confirm, error: this._errorMessage(err) };
    }
  }

  // --- Copie vers d'autres pièces (US8) ---

  _openCopyRoomDialog() {
    this._menuOpen = false;
    this._copyRoomDialog = { targets: new Set(), error: null };
  }

  _closeCopyRoomDialog() {
    this._copyRoomDialog = null;
  }

  _toggleCopyRoomTarget(roomId) {
    const targets = new Set(this._copyRoomDialog.targets);
    if (targets.has(roomId)) {
      targets.delete(roomId);
    } else {
      targets.add(roomId);
    }
    this._copyRoomDialog = { ...this._copyRoomDialog, targets };
  }

  async _confirmCopyRoom() {
    const targets = Array.from(this._copyRoomDialog.targets);
    if (targets.length === 0) return;
    try {
      await this._sendMessage({
        type: "heatwise/copy_room_schedule",
        room_id: this.roomId,
        target_room_ids: targets,
      });
      this._copyRoomDialog = null;
    } catch (err) {
      this._copyRoomDialog = { ...this._copyRoomDialog, error: this._errorMessage(err) };
    }
  }

  // --- Rendu ---

  _currentWeek() {
    if (!this._schedule) return null;
    return this._program === "vacation" ? this._schedule.vacation : this._schedule.weeks[this._program];
  }

  _toggleMenu() {
    this._menuOpen = !this._menuOpen;
  }

  _selectProgram(program) {
    this._program = program;
    this._menuOpen = false;
  }

  render() {
    if (this._loading && !this._schedule) {
      return html`
        <div class="header">
          <h2>Programmation — ${this.roomName}</h2>
          <button class="icon-button" aria-label="Fermer" @click=${this._close}>
            <ha-icon icon="mdi:close"></ha-icon>
          </button>
        </div>
        <p class="hint">Chargement…</p>
      `;
    }

    if (this._error && !this._schedule) {
      return html`
        <div class="header">
          <h2>Programmation — ${this.roomName}</h2>
          <button class="icon-button" aria-label="Fermer" @click=${this._close}>
            <ha-icon icon="mdi:close"></ha-icon>
          </button>
        </div>
        <p class="dialog-error">${this._error}</p>
      `;
    }

    const week = this._currentWeek();
    const isVacationActive = this._active.program === "vacation";

    return html`
      <div class="header">
        <h2 title="Programmation — ${this.roomName}">Programmation — ${this.roomName}</h2>
        <button class="icon-button" aria-label="Fermer" @click=${this._close}>
          <ha-icon icon="mdi:close"></ha-icon>
        </button>
      </div>

      ${isVacationActive
        ? html`<div class="vacation-banner">
            La programmation Vacances s'applique actuellement.
          </div>`
        : ""}

      <div class="toolbar">
        <div class="tabs">
          ${this._schedule.parity
            ? html`
                <button
                  class="tab ${this._program === "even" ? "active" : ""}"
                  @click=${() => this._selectProgram("even")}
                >
                  Semaine paire
                </button>
                <button
                  class="tab ${this._program === "odd" ? "active" : ""}"
                  @click=${() => this._selectProgram("odd")}
                >
                  Semaine impaire
                </button>
              `
            : html`
                <button
                  class="tab ${this._program === "all" ? "active" : ""}"
                  @click=${() => this._selectProgram("all")}
                >
                  Semaine
                </button>
              `}
          <button
            class="tab ${this._program === "vacation" ? "active" : ""}"
            @click=${() => this._selectProgram("vacation")}
          >
            Vacances
          </button>
        </div>
        <span class="week-indicator">
          Semaine en cours : n° ${this._active.week_number}
          ${this._schedule.parity && this._active.program !== "vacation"
            ? ` (${this._active.program === "even" ? "paire" : "impaire"})`
            : ""}
        </span>
        <div class="spacer"></div>
        <div class="menu-wrapper">
          <button class="icon-button" aria-label="Actions" @click=${this._toggleMenu}>
            <ha-icon icon="mdi:dots-vertical"></ha-icon>
          </button>
          ${this._menuOpen ? this._renderMenu() : ""}
        </div>
      </div>

      <div class="legend">
        <span>Froid</span>
        <div class="legend-gradient"></div>
        <span>Chaud</span>
        <span>· Hors plage : ${formatTemperature(this._settings.default_temperature)} °C</span>
      </div>

      <div class="schedule-wrapper ${this.narrow ? "narrow" : ""}">
        <div
          class="schedule-body"
          @pointerdown=${this._onGridPointerDown}
          @pointermove=${this._onGridPointerMove}
          @pointerup=${this._onGridPointerUp}
          @pointercancel=${this._onGridPointerUp}
        >
          <div class="hours-column">
            <div class="day-header"></div>
            ${Array.from({ length: 25 }, (_, h) => h).map(
              (h) => html`<span class="hour-label" style="top: ${(h / 24) * 100}%">${h}h</span>`
            )}
          </div>
          ${DAY_ORDER.map((day) => this._renderDayColumn(day, week))}
        </div>
      </div>

      ${this._slotDialog ? this._renderSlotDialog() : ""}
      ${this._copyDayDialog ? this._renderCopyDayDialog() : ""}
      ${this._copyRoomDialog ? this._renderCopyRoomDialog() : ""}
      ${this._parityKeepDialog ? this._renderParityKeepDialog() : ""}
      ${this._confirm ? this._renderConfirmDialog() : ""}
    `;
  }

  _renderMenu() {
    const parity = this._schedule.parity;
    return html`
      <div class="menu">
        ${parity
          ? html`
              <button @click=${this._openParityKeepDialog}>
                Désactiver les semaines paires/impaires
              </button>
              ${this._program !== "vacation"
                ? html`<button
                    @click=${() => this._askCopyParity(this._program === "even" ? "odd" : "even")}
                  >
                    Copier vers la semaine ${this._program === "even" ? "impaire" : "paire"}
                  </button>`
                : ""}
            `
          : html`<button @click=${this._enableParity}>
              Activer les semaines paires/impaires
            </button>`}
        ${this._program !== "vacation"
          ? html`<button @click=${this._askCopyToVacation}>Copier vers Vacances</button>`
          : ""}
        <button @click=${this._openCopyRoomDialog}>Copier vers d'autres pièces</button>
      </div>
    `;
  }

  _renderDayColumn(day, week) {
    const isToday = this._active.program === this._program && this._active.weekday === day;
    const selectionRect = this._selectionRectFor(day);
    const slots = week[day] || [];
    return html`
      <div class="day-column ${isToday ? "today" : ""}" data-day=${day}>
        <div class="day-header ${isToday ? "today" : ""}">
          <span>${DAY_LABELS[day]}</span>
          <button
            class="icon-button copy-day-button"
            aria-label="Copier ce jour"
            title="Copier ce jour"
            @click=${(event) => {
              event.stopPropagation();
              this._openCopyDayDialog(day);
            }}
          >
            <ha-icon icon="mdi:content-copy"></ha-icon>
          </button>
        </div>
        ${Array.from({ length: 24 }, (_, h) => h).map(
          (h) => html`<div class="hour-line" style="top: ${(h / 24) * 100}%"></div>`
        )}
        ${isToday
          ? html`<div
              class="now-line"
              style="top: ${((this._active.minute) / DAY_MINUTES) * 100}%"
            ></div>`
          : ""}
        ${slots.map((slot) => this._renderSlot(day, slot))}
        ${selectionRect
          ? html`<div
              class="selection-preview"
              style="top: ${(selectionRect.start / DAY_MINUTES) * 100}%; height: ${((selectionRect.end -
                selectionRect.start) /
                DAY_MINUTES) *
              100}%"
            ></div>`
          : ""}
      </div>
    `;
  }

  _renderSlot(day, slot) {
    const color = temperatureToColor(slot.temperature);
    const height = ((slot.end - slot.start) / DAY_MINUTES) * 100;
    const showText = slot.end - slot.start >= 45; // T020 : ≥ 45 min pour afficher le texte
    const label = `${formatTemperature(slot.temperature)} °C, ${formatMinutes(slot.start)} – ${formatMinutes(
      slot.end
    )}`;
    return html`
      <div
        class="schedule-slot"
        style="top: ${(slot.start / DAY_MINUTES) * 100}%; height: ${height}%; background: ${color}; color: ${textColorFor(
          color
        )}"
        title=${label}
        @pointerdown=${(event) => event.stopPropagation()}
        @click=${() => this._onSlotClick(day, slot)}
      >
        ${showText ? formatTemperature(slot.temperature) : ""}
      </div>
    `;
  }

  _renderSlotDialog() {
    const dialog = this._slotDialog;
    const daysLabel =
      dialog.mode === "edit"
        ? DAY_LABELS[dialog.day]
        : dialog.days.map((d) => DAY_LABELS[d]).join(", ");
    return html`
      <div class="dialog-overlay">
        <div class="dialog">
          <h2>${dialog.mode === "edit" ? "Modifier la plage" : "Nouvelle plage"}</h2>
          <p class="hint">${daysLabel}</p>
          <div>
            <label for="hw-slot-temperature">Température (°C)</label>
            <input
              id="hw-slot-temperature"
              type="number"
              min=${MIN_TEMPERATURE}
              max=${MAX_TEMPERATURE}
              step=${TEMPERATURE_STEP}
              .value=${String(dialog.temperature)}
              @input=${this._onSlotTemperatureInput}
            />
          </div>
          <div class="time-row">
            <div>
              <label for="hw-slot-start">Début</label>
              <select id="hw-slot-start" @change=${this._onSlotStartInput}>
                ${TIME_OPTIONS.filter((o) => o.minutes < DAY_MINUTES).map(
                  (o) => html`<option value=${o.minutes} ?selected=${o.minutes === dialog.start}>
                    ${o.label}
                  </option>`
                )}
              </select>
            </div>
            <div>
              <label for="hw-slot-end">Fin</label>
              <select id="hw-slot-end" @change=${this._onSlotEndInput}>
                ${TIME_OPTIONS.filter((o) => o.minutes > 0).map(
                  (o) => html`<option value=${o.minutes} ?selected=${o.minutes === dialog.end}>
                    ${o.label}
                  </option>`
                )}
              </select>
            </div>
          </div>
          ${dialog.error ? html`<p class="dialog-error">${dialog.error}</p>` : ""}
          <div class="dialog-actions">
            ${dialog.mode === "edit"
              ? html`<button class="button-danger" @click=${this._deleteSlot}>Supprimer</button>`
              : ""}
            <button class="button-secondary" @click=${this._closeSlotDialog}>Annuler</button>
            <button class="button-primary" @click=${this._saveSlotDialog}>Enregistrer</button>
          </div>
        </div>
      </div>
    `;
  }

  _renderCopyDayDialog() {
    const { source, targets, error } = this._copyDayDialog;
    const otherDays = DAY_ORDER.filter((d) => d !== source);
    return html`
      <div class="dialog-overlay">
        <div class="dialog">
          <h2>Copier ${DAY_LABELS[source]} vers…</h2>
          <div class="shortcut-row">
            <button class="button-secondary" @click=${() => this._applyCopyDayShortcut(WORKDAYS)}>
              Jours ouvrés
            </button>
            <button class="button-secondary" @click=${() => this._applyCopyDayShortcut(WEEKEND_DAYS)}>
              Week-end
            </button>
          </div>
          <div class="checkbox-list">
            ${otherDays.map(
              (day) => html`
                <label class="checkbox-row">
                  <input
                    type="checkbox"
                    .checked=${targets.has(day)}
                    @change=${() => this._toggleCopyDayTarget(day)}
                  />
                  ${DAY_LABELS[day]}
                  ${this._copyDayHasExistingPlages(day)
                    ? html`<span class="hint">(sera remplacé)</span>`
                    : ""}
                </label>
              `
            )}
          </div>
          ${error ? html`<p class="dialog-error">${error}</p>` : ""}
          <div class="dialog-actions">
            <button class="button-secondary" @click=${this._closeCopyDayDialog}>Annuler</button>
            <button
              class="button-primary"
              ?disabled=${targets.size === 0}
              @click=${this._confirmCopyDay}
            >
              Copier
            </button>
          </div>
        </div>
      </div>
    `;
  }

  _renderCopyRoomDialog() {
    const { targets, error } = this._copyRoomDialog;
    const others = (this.rooms || []).filter((r) => r.room_id !== this.roomId);
    return html`
      <div class="dialog-overlay">
        <div class="dialog">
          <h2>Copier vers d'autres pièces</h2>
          <p class="hint">
            La programmation des pièces cochées sera intégralement remplacée par
            celle de « ${this.roomName} ».
          </p>
          <div class="checkbox-list">
            ${others.map(
              (room) => html`
                <label class="checkbox-row">
                  <input
                    type="checkbox"
                    .checked=${targets.has(room.room_id)}
                    @change=${() => this._toggleCopyRoomTarget(room.room_id)}
                  />
                  ${room.name}
                </label>
              `
            )}
          </div>
          ${error ? html`<p class="dialog-error">${error}</p>` : ""}
          <div class="dialog-actions">
            <button class="button-secondary" @click=${this._closeCopyRoomDialog}>Annuler</button>
            <button
              class="button-primary"
              ?disabled=${targets.size === 0}
              @click=${this._confirmCopyRoom}
            >
              Copier
            </button>
          </div>
        </div>
      </div>
    `;
  }

  _renderParityKeepDialog() {
    const { keep, error } = this._parityKeepDialog;
    return html`
      <div class="dialog-overlay">
        <div class="dialog">
          <h2>Désactiver les semaines paires/impaires</h2>
          <p class="hint">Quelle semaine souhaitez-vous conserver ?</p>
          <label class="checkbox-row">
            <input
              type="radio"
              name="hw-keep"
              value="even"
              .checked=${keep === "even"}
              @change=${this._onKeepChoiceChange}
            />
            Semaine paire
          </label>
          <label class="checkbox-row">
            <input
              type="radio"
              name="hw-keep"
              value="odd"
              .checked=${keep === "odd"}
              @change=${this._onKeepChoiceChange}
            />
            Semaine impaire
          </label>
          ${error ? html`<p class="dialog-error">${error}</p>` : ""}
          <div class="dialog-actions">
            <button class="button-secondary" @click=${this._closeParityKeepDialog}>Annuler</button>
            <button class="button-primary" @click=${this._confirmDisableParity}>Confirmer</button>
          </div>
        </div>
      </div>
    `;
  }

  _renderConfirmDialog() {
    const { message, error } = this._confirm;
    return html`
      <div class="dialog-overlay">
        <div class="dialog">
          <h2>Confirmer</h2>
          <p class="hint">${message}</p>
          ${error ? html`<p class="dialog-error">${error}</p>` : ""}
          <div class="dialog-actions">
            <button class="button-secondary" @click=${this._closeConfirm}>Annuler</button>
            <button class="button-primary" @click=${this._runConfirm}>Confirmer</button>
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define("heatwise-schedule", HeatwiseSchedule);
