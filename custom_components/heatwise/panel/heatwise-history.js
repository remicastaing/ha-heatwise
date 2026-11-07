import { LitElement, html, svg, css } from "./vendor/lit-core.min.js";
import { regulationLabel } from "./heatwise-labels.js";

// Spec 010 : graphique de l'historique d'une pièce (research R7). SVG
// dessiné à la largeur réelle du conteneur (lisible sur téléphone,
// FR-013c) à partir de `heatwise/get_room_history`
// (contracts/websocket-api.md) : `null` = trou, jamais relié (FR-013b).

export const PERIODS = [
  { id: "24h", label: "24 h" },
  { id: "7d", label: "7 jours" },
  { id: "30d", label: "30 jours" },
];

export const HEIGHT = 260;

// Spec 013 : affichage de la courbe extérieure, mémorisé par navigateur.
const OUTDOOR_KEY = "heatwise.history.showOutdoor";

function loadShowOutdoor() {
  try {
    return window.localStorage.getItem(OUTDOOR_KEY) !== "false";
  } catch (err) {
    return true;
  }
}

function storeShowOutdoor(value) {
  try {
    window.localStorage.setItem(OUTDOOR_KEY, String(value));
  } catch (err) {
    // Stockage indisponible : le choix vaut pour la session.
  }
}
export const MARGIN = { top: 12, right: 40, bottom: 26, left: 40 };

// Bandes de fond par état (FR-013) ; la chauffe prime sur le statut.
const BANDS = {
  heating: { label: "Chauffe", color: "rgba(249, 115, 22, 0.22)" },
  suspended: { label: "Suspendue", color: "rgba(124, 58, 237, 0.13)" },
  safety_stop: { label: "Arrêt de sécurité", color: "rgba(220, 38, 38, 0.16)" },
  not_regulated: { label: "Non régulée", color: "rgba(120, 120, 120, 0.13)" },
};

function bandKind(change) {
  if (change.heating) {
    return "heating";
  }
  return BANDS[change.status] ? change.status : null;
}

export function niceRange(values, pad, step) {
  if (!values.length) {
    return null;
  }
  const low = Math.floor((Math.min(...values) - pad) / step) * step;
  const high = Math.ceil((Math.max(...values) + pad) / step) * step;
  return high > low ? [low, high] : [low - step, high + step];
}

export function formatNumber(value, digits) {
  return Number(value).toLocaleString("fr-FR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatInstant(ms, period) {
  const date = new Date(ms);
  const time = date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  if (period === "24h") {
    return time;
  }
  const day = date.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "2-digit" });
  return `${day} ${time}`;
}

// Graduations de l'axe du temps, alignées sur l'heure locale.
export function timeTicks(startMs, endMs, period) {
  const ticks = [];
  const cursor = new Date(startMs);
  cursor.setMinutes(0, 0, 0);
  if (period === "24h") {
    cursor.setHours(Math.ceil(cursor.getHours() / 3) * 3);
    for (; cursor.getTime() < endMs; cursor.setHours(cursor.getHours() + 3)) {
      if (cursor.getTime() >= startMs) {
        ticks.push({ ms: cursor.getTime(), label: `${String(cursor.getHours()).padStart(2, "0")}h` });
      }
    }
    return ticks;
  }
  cursor.setHours(0);
  const everyDays = period === "7d" ? 1 : 5;
  for (; cursor.getTime() < endMs; cursor.setDate(cursor.getDate() + everyDays)) {
    if (cursor.getTime() >= startMs) {
      ticks.push({
        ms: cursor.getTime(),
        label:
          period === "7d"
            ? cursor.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" })
            : cursor.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }),
      });
    }
  }
  return ticks;
}

// Chemin SVG d'une série, découpé sur les trous ; un point isolé entre
// deux trous est rendu comme un point (FR-013b).
export function seriesShapes(values, x, y) {
  const paths = [];
  const dots = [];
  let run = [];
  const flush = () => {
    if (run.length === 1) {
      dots.push(run[0]);
    } else if (run.length > 1) {
      paths.push(run.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(""));
    }
    run = [];
  };
  values.forEach((value, i) => {
    if (value === null || value === undefined) {
      flush();
    } else {
      run.push([x(i), y(value)]);
    }
  });
  flush();
  return { paths, dots };
}

class HeatwiseHistory extends LitElement {
  static properties = {
    hass: { attribute: false },
    roomId: { type: String },
    roomName: { type: String },
    _period: { state: true },
    _data: { state: true },
    _loading: { state: true },
    _error: { state: true },
    _width: { state: true },
    _hover: { state: true },
    _showOutdoor: { state: true },
  };

  static styles = css`
    :host {
      display: block;
      box-sizing: border-box;
      --hw-bg: var(--primary-background-color, #f7f6f3);
      --hw-card: var(--card-background-color, #ffffff);
      --hw-border: var(--divider-color, #e5e3de);
      --hw-text: var(--primary-text-color, #1f1f1d);
      --hw-text-secondary: var(--secondary-text-color, #726f6a);
      --hw-accent: var(--primary-color, #0b84c4);
      --hw-temperature: var(--hw-accent);
      --hw-humidity: #43a047;
      --hw-target: #d97706;
      --hw-outdoor: #78909c;
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
      min-width: 0;
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

    .periods {
      display: inline-flex;
      border: 1px solid var(--hw-border);
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 12px;
    }
    .periods button {
      border: none;
      background: var(--hw-card);
      color: var(--hw-text-secondary);
      padding: 6px 12px;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
    }
    .periods button + button {
      border-left: 1px solid var(--hw-border);
    }
    .periods button.active {
      background: var(--hw-accent);
      color: #fff;
    }

    .chart {
      position: relative;
      background: var(--hw-card);
      border: 1px solid var(--hw-border);
      border-radius: 12px;
      padding: 8px 0;
      touch-action: pan-y;
    }
    svg {
      display: block;
      user-select: none;
    }
    .axis {
      font-size: 11px;
      fill: var(--hw-text-secondary);
    }
    .grid {
      stroke: var(--hw-border);
      stroke-width: 1;
    }
    .cursor {
      stroke: var(--hw-text-secondary);
      stroke-width: 1;
      stroke-dasharray: 3 3;
    }

    .tooltip {
      position: absolute;
      top: 8px;
      pointer-events: none;
      background: var(--hw-card);
      border: 1px solid var(--hw-border);
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 12px;
      line-height: 1.5;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12);
      white-space: nowrap;
      max-width: calc(100% - 16px);
    }
    .tooltip strong {
      display: block;
    }

    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 14px;
      margin-top: 10px;
      font-size: 12px;
      color: var(--hw-text-secondary);
    }
    .legend span {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .swatch-line {
      width: 16px;
      height: 0;
      border-top: 2px solid;
    }
    .legend label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
    }
    .legend input {
      margin: 0;
    }
    .swatch-band {
      width: 12px;
      height: 12px;
      border-radius: 3px;
    }

    .hint {
      color: var(--hw-text-secondary);
      font-size: 13px;
    }
    .error {
      color: var(--error-color, #c62828);
      font-size: 13px;
    }
  `;

  constructor() {
    super();
    this._period = "24h";
    this._data = null;
    this._loading = false;
    this._error = null;
    this._width = 0;
    this._hover = null;
    this._showOutdoor = loadShowOutdoor();
    this._resizeObserver = new ResizeObserver((entries) => {
      const width = Math.floor(entries[0].contentRect.width);
      if (width !== this._width) {
        this._width = width;
      }
    });
  }

  connectedCallback() {
    super.connectedCallback();
    this._load();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._resizeObserver.disconnect();
  }

  firstUpdated() {
    this._resizeObserver.observe(this.renderRoot.querySelector(".chart"));
  }

  async _load() {
    if (!this.hass || !this.roomId) {
      return;
    }
    const period = this._period;
    this._loading = true;
    this._error = null;
    try {
      const data = await this.hass.connection.sendMessagePromise({
        type: "heatwise/get_room_history",
        room_id: this.roomId,
        period,
      });
      if (period === this._period) {
        this._data = data;
      }
    } catch (err) {
      this._data = null;
      this._error = "Historique indisponible.";
    } finally {
      this._loading = false;
    }
  }

  _setPeriod(period) {
    if (period !== this._period) {
      this._period = period;
      this._hover = null;
      this._load();
    }
  }

  _close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }

  // --- Géométrie ---

  _geometry() {
    const data = this._data;
    const width = Math.max(this._width, 240);
    const plotWidth = width - MARGIN.left - MARGIN.right;
    const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
    const startMs = Date.parse(data.start);
    const endMs = Date.parse(data.end);
    const count = data.temperature.length;
    const bucketMs = data.bucket_seconds * 1000;

    const temperatures = data.temperature.filter((v) => v !== null);
    const targets = data.regulation.map((c) => c.target);
    // L'extérieur n'entre dans l'échelle que s'il est affiché (research R6).
    const outdoor = this._outdoorShown() ? data.outdoor.filter((v) => v !== null) : [];
    const tempRange = niceRange([...temperatures, ...targets, ...outdoor], 0.5, 1) || [15, 25];
    const humidities = data.humidity.filter((v) => v !== null);
    const humRange = humidities.length
      ? niceRange(humidities, 5, 10).map((v) => Math.min(100, Math.max(0, v)))
      : null;

    const xMs = (ms) => MARGIN.left + ((ms - startMs) / (endMs - startMs)) * plotWidth;
    const xIndex = (i) => xMs(startMs + (i + 0.5) * bucketMs);
    const scale = ([low, high]) => (v) => MARGIN.top + plotHeight - ((v - low) / (high - low)) * plotHeight;
    return {
      width,
      plotWidth,
      plotHeight,
      startMs,
      endMs,
      count,
      bucketMs,
      tempRange,
      humRange,
      xMs,
      xIndex,
      yTemp: scale(tempRange),
      yHum: humRange ? scale(humRange) : null,
    };
  }

  _hasOutdoor() {
    return Boolean(this._data && this._data.outdoor && this._data.outdoor.some((v) => v !== null));
  }

  _outdoorShown() {
    return this._showOutdoor && this._hasOutdoor();
  }

  _toggleOutdoor(event) {
    this._showOutdoor = event.target.checked;
    storeShowOutdoor(this._showOutdoor);
  }

  // Changements de régulation sous forme d'intervalles [début, fin).
  _segments(g) {
    const changes = this._data.regulation;
    return changes.map((change, i) => ({
      ...change,
      fromMs: Math.max(Date.parse(change.at), g.startMs),
      toMs: i + 1 < changes.length ? Date.parse(changes[i + 1].at) : Math.min(Date.now(), g.endMs),
    }));
  }

  _stateAt(ms, segments) {
    return segments.find((s) => s.fromMs <= ms && ms < s.toMs) || null;
  }

  _onPointer(event, g) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const index = Math.floor(((x - MARGIN.left) / g.plotWidth) * g.count);
    this._hover = index >= 0 && index < g.count ? index : null;
  }

  // --- Rendu ---

  _renderChart() {
    const g = this._geometry();
    const segments = this._segments(g);
    const temp = seriesShapes(this._data.temperature, g.xIndex, g.yTemp);
    const hum = g.yHum ? seriesShapes(this._data.humidity, g.xIndex, g.yHum) : { paths: [], dots: [] };
    const out = this._outdoorShown()
      ? seriesShapes(this._data.outdoor, g.xIndex, g.yTemp)
      : { paths: [], dots: [] };
    const target = segments
      .map((s) => `M${g.xMs(s.fromMs).toFixed(1)},${g.yTemp(s.target).toFixed(1)}H${g.xMs(s.toMs).toFixed(1)}`)
      .join("");
    const tempTicks = [];
    const tempStep = g.tempRange[1] - g.tempRange[0] > 8 ? 2 : 1;
    for (let v = g.tempRange[0]; v <= g.tempRange[1]; v += tempStep) {
      tempTicks.push(v);
    }
    const humTicks = g.humRange ? [g.humRange[0], (g.humRange[0] + g.humRange[1]) / 2, g.humRange[1]] : [];
    const bottom = MARGIN.top + g.plotHeight;
    const hover = this._hover;

    return svg`
      <svg width=${g.width} height=${HEIGHT} role="img"
        aria-label="Historique de température et d'humidité"
        @pointermove=${(e) => this._onPointer(e, g)}
        @pointerdown=${(e) => this._onPointer(e, g)}
        @pointerleave=${() => (this._hover = null)}>
        ${segments.map((s) => {
          const kind = bandKind(s);
          return kind
            ? svg`<rect x=${g.xMs(s.fromMs)} y=${MARGIN.top} width=${Math.max(0, g.xMs(s.toMs) - g.xMs(s.fromMs))}
                height=${g.plotHeight} fill=${BANDS[kind].color}></rect>`
            : "";
        })}
        ${tempTicks.map(
          (v) => svg`
            <line class="grid" x1=${MARGIN.left} x2=${MARGIN.left + g.plotWidth} y1=${g.yTemp(v)} y2=${g.yTemp(v)}></line>
            <text class="axis" x=${MARGIN.left - 6} y=${g.yTemp(v) + 4} text-anchor="end">${v}°</text>`
        )}
        ${humTicks.map(
          (v) => svg`<text class="axis" x=${MARGIN.left + g.plotWidth + 6} y=${g.yHum(v) + 4}>${Math.round(v)}%</text>`
        )}
        ${timeTicks(g.startMs, g.endMs, this._period).map(
          (t) => svg`
            <line class="grid" x1=${g.xMs(t.ms)} x2=${g.xMs(t.ms)} y1=${bottom} y2=${bottom + 4}></line>
            <text class="axis" x=${g.xMs(t.ms)} y=${bottom + 17} text-anchor="middle">${t.label}</text>`
        )}
        <path d=${target} fill="none" stroke="var(--hw-target)" stroke-width="1.5" stroke-dasharray="5 3"></path>
        ${out.paths.map((d) => svg`<path d=${d} fill="none" stroke="var(--hw-outdoor)" stroke-width="1.2" stroke-dasharray="2 2"></path>`)}
        ${out.dots.map(([cx, cy]) => svg`<circle cx=${cx} cy=${cy} r="1.8" fill="var(--hw-outdoor)"></circle>`)}
        ${hum.paths.map((d) => svg`<path d=${d} fill="none" stroke="var(--hw-humidity)" stroke-width="1.2" opacity="0.8"></path>`)}
        ${hum.dots.map(([cx, cy]) => svg`<circle cx=${cx} cy=${cy} r="2" fill="var(--hw-humidity)"></circle>`)}
        ${temp.paths.map((d) => svg`<path d=${d} fill="none" stroke="var(--hw-temperature)" stroke-width="2"></path>`)}
        ${temp.dots.map(([cx, cy]) => svg`<circle cx=${cx} cy=${cy} r="2.5" fill="var(--hw-temperature)"></circle>`)}
        ${hover !== null
          ? svg`<line class="cursor" x1=${g.xIndex(hover)} x2=${g.xIndex(hover)} y1=${MARGIN.top} y2=${bottom}></line>`
          : ""}
      </svg>
      ${hover !== null ? this._renderTooltip(g, segments, hover) : ""}
    `;
  }

  _renderTooltip(g, segments, index) {
    const ms = g.startMs + index * g.bucketMs;
    const temperature = this._data.temperature[index];
    const humidity = this._data.humidity[index];
    const outdoor = this._data.outdoor ? this._data.outdoor[index] : null;
    const state = this._stateAt(ms + g.bucketMs / 2, segments);
    const label = state ? regulationLabel({ ...state, suspended_until: null }) : null;
    const x = g.xIndex(index);
    const style = x > g.width / 2 ? `right: ${g.width - x + 8}px` : `left: ${x + 8}px`;
    return html`
      <div class="tooltip" style=${style}>
        <strong>${formatInstant(ms, this._period)}</strong>
        Température : ${temperature === null ? "—" : `${formatNumber(temperature, 1)} °C`}<br />
        Humidité : ${humidity === null ? "—" : `${Math.round(humidity)} %`}<br />
        ${this._outdoorShown() && outdoor !== null && outdoor !== undefined
          ? html`Extérieur : ${formatNumber(outdoor, 1)} °C<br />`
          : ""}
        ${state ? html`Consigne : ${formatNumber(state.target, 1)} °C<br />` : ""}
        ${label ? html`${state.heating && state.status !== "heating" ? "Chauffe — " : ""}${label.text}` : ""}
      </div>
    `;
  }

  _renderLegend() {
    return html`
      <div class="legend">
        <span><i class="swatch-line" style="border-color: var(--hw-temperature)"></i>Température</span>
        <span><i class="swatch-line" style="border-color: var(--hw-humidity)"></i>Humidité</span>
        <span><i class="swatch-line" style="border-color: var(--hw-target); border-top-style: dashed"></i>Consigne</span>
        ${this._hasOutdoor()
          ? html`<label>
              <input type="checkbox" .checked=${this._showOutdoor} @change=${this._toggleOutdoor} />
              <i class="swatch-line" style="border-color: var(--hw-outdoor); border-top-style: dotted"></i>Extérieur
            </label>`
          : ""}
        ${Object.values(BANDS).map(
          (band) => html`<span><i class="swatch-band" style="background: ${band.color}"></i>${band.label}</span>`
        )}
      </div>
    `;
  }

  _renderBody() {
    if (this._error) {
      return html`<p class="error">${this._error}</p>`;
    }
    if (!this._data) {
      return html`<p class="hint">Chargement…</p>`;
    }
    const empty = !this._data.has_data;
    if (empty && !this._data.regulation.length) {
      return html`<p class="hint">Aucune mesure disponible sur cette période.</p>`;
    }
    return html`
      ${empty ? html`<p class="hint">Aucune mesure disponible sur cette période.</p>` : ""}
      ${this._width ? this._renderChart() : ""}
    `;
  }

  render() {
    return html`
      <div class="header">
        <h2 title="Historique — ${this.roomName}">Historique — ${this.roomName}</h2>
        <button class="icon-button" aria-label="Fermer" @click=${this._close}>
          <ha-icon icon="mdi:close"></ha-icon>
        </button>
      </div>
      <div class="periods" role="group" aria-label="Période">
        ${PERIODS.map(
          (p) => html`
            <button
              class=${p.id === this._period ? "active" : ""}
              aria-pressed=${p.id === this._period}
              ?disabled=${this._loading}
              @click=${() => this._setPeriod(p.id)}
            >
              ${p.label}
            </button>
          `
        )}
      </div>
      <div class="chart">${this._renderBody()}</div>
      ${this._data && !this._error ? this._renderLegend() : ""}
    `;
  }
}

customElements.define("heatwise-history", HeatwiseHistory);
