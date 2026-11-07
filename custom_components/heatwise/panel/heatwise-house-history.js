import { LitElement, html, svg, css } from "./vendor/lit-core.min.js";
import {
  PERIODS,
  formatInstant,
  formatNumber,
  niceRange,
  seriesShapes,
  timeTicks,
} from "./heatwise-history.js";

// Spec 013 (US4) : historique des températures de toutes les pièces et de
// l'extérieur sur un même graphique, à partir de `heatwise/get_house_history`
// (contracts/websocket-api.md) : `null` = trou, jamais relié.

const HEIGHT = 320;
const MARGIN = { top: 12, right: 16, bottom: 26, left: 40 };
const OUTDOOR = "__outdoor__";
const HIDDEN_KEY = "heatwise.houseHistory.hidden";

// Palette catégorielle validée (dataviz, 7 créneaux, clair / sombre). La
// couleur suit la pièce (rang dans `roomOrder`), jamais sa présence sur la
// période : masquer ou perdre une courbe ne repeint pas les autres.
const PALETTE = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9"],
};

function loadHidden() {
  try {
    const value = JSON.parse(window.localStorage.getItem(HIDDEN_KEY) || "[]");
    return new Set(Array.isArray(value) ? value : []);
  } catch (err) {
    return new Set();
  }
}

function storeHidden(hidden) {
  try {
    window.localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
  } catch (err) {
    // Stockage indisponible : le choix vaut pour la session.
  }
}

class HeatwiseHouseHistory extends LitElement {
  static properties = {
    hass: { attribute: false },
    roomOrder: { attribute: false },
    _period: { state: true },
    _data: { state: true },
    _loading: { state: true },
    _error: { state: true },
    _width: { state: true },
    _hover: { state: true },
    _hidden: { state: true },
  };

  static styles = css`
    :host {
      display: block;
      box-sizing: border-box;
      --hw-card: var(--card-background-color, #ffffff);
      --hw-border: var(--divider-color, #e5e3de);
      --hw-text: var(--primary-text-color, #1f1f1d);
      --hw-text-secondary: var(--secondary-text-color, #726f6a);
      --hw-accent: var(--primary-color, #0b84c4);
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
    }
    .tooltip strong {
      display: block;
    }
    .tooltip-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tooltip-row .value {
      margin-left: auto;
      padding-left: 12px;
      font-variant-numeric: tabular-nums;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 14px;
      margin-top: 10px;
      font-size: 12px;
      color: var(--hw-text-secondary);
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
    .swatch-line {
      display: inline-block;
      width: 16px;
      height: 0;
      border-top: 2px solid;
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
    this.roomOrder = [];
    this._period = "24h";
    this._data = null;
    this._loading = false;
    this._error = null;
    this._width = 0;
    this._hover = null;
    this._hidden = loadHidden();
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
    if (!this.hass) {
      return;
    }
    const period = this._period;
    this._loading = true;
    this._error = null;
    try {
      const data = await this.hass.connection.sendMessagePromise({
        type: "heatwise/get_house_history",
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

  _toggle(id, visible) {
    const hidden = new Set(this._hidden);
    if (visible) {
      hidden.delete(id);
    } else {
      hidden.add(id);
    }
    this._hidden = hidden;
    storeHidden(hidden);
  }

  // Toutes les courbes de la réponse, pièces puis extérieur, avec leur
  // couleur stable.
  _curves() {
    const palette = this.hass && this.hass.themes && this.hass.themes.darkMode ? PALETTE.dark : PALETTE.light;
    const order = this.roomOrder || [];
    const curves = this._data.rooms.map((room, i) => {
      const rank = order.indexOf(room.room_id);
      return {
        id: room.room_id,
        name: room.name,
        values: room.temperature,
        color: palette[(rank >= 0 ? rank : order.length + i) % palette.length],
        dashed: false,
      };
    });
    if (this._data.outdoor.some((v) => v !== null)) {
      curves.push({
        id: OUTDOOR,
        name: "Extérieur",
        values: this._data.outdoor,
        color: "var(--hw-outdoor)",
        dashed: true,
      });
    }
    return curves;
  }

  _geometry(visible) {
    const data = this._data;
    const width = Math.max(this._width, 240);
    const plotWidth = width - MARGIN.left - MARGIN.right;
    const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
    const startMs = Date.parse(data.start);
    const endMs = Date.parse(data.end);
    const count = data.outdoor.length;
    const bucketMs = data.bucket_seconds * 1000;
    const values = visible.flatMap((c) => c.values.filter((v) => v !== null));
    const tempRange = niceRange(values, 0.5, 1) || [15, 25];
    const xMs = (ms) => MARGIN.left + ((ms - startMs) / (endMs - startMs)) * plotWidth;
    const xIndex = (i) => xMs(startMs + (i + 0.5) * bucketMs);
    const [low, high] = tempRange;
    const yTemp = (v) => MARGIN.top + plotHeight - ((v - low) / (high - low)) * plotHeight;
    return { width, plotWidth, plotHeight, startMs, endMs, count, bucketMs, tempRange, xMs, xIndex, yTemp };
  }

  _onPointer(event, g) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const index = Math.floor(((x - MARGIN.left) / g.plotWidth) * g.count);
    this._hover = index >= 0 && index < g.count ? index : null;
  }

  _renderChart(visible) {
    const g = this._geometry(visible);
    const bottom = MARGIN.top + g.plotHeight;
    const tempStep = g.tempRange[1] - g.tempRange[0] > 8 ? 2 : 1;
    const ticks = [];
    for (let v = g.tempRange[0]; v <= g.tempRange[1]; v += tempStep) {
      ticks.push(v);
    }
    const hover = this._hover;
    return html`
      ${svg`
        <svg width=${g.width} height=${HEIGHT} role="img"
          aria-label="Historique des températures de toutes les pièces"
          @pointermove=${(e) => this._onPointer(e, g)}
          @pointerdown=${(e) => this._onPointer(e, g)}
          @pointerleave=${() => (this._hover = null)}>
          ${ticks.map(
            (v) => svg`
              <line class="grid" x1=${MARGIN.left} x2=${MARGIN.left + g.plotWidth} y1=${g.yTemp(v)} y2=${g.yTemp(v)}></line>
              <text class="axis" x=${MARGIN.left - 6} y=${g.yTemp(v) + 4} text-anchor="end">${v}°</text>`
          )}
          ${timeTicks(g.startMs, g.endMs, this._period).map(
            (t) => svg`
              <line class="grid" x1=${g.xMs(t.ms)} x2=${g.xMs(t.ms)} y1=${bottom} y2=${bottom + 4}></line>
              <text class="axis" x=${g.xMs(t.ms)} y=${bottom + 17} text-anchor="middle">${t.label}</text>`
          )}
          ${visible.map((curve) => {
            const shapes = seriesShapes(curve.values, g.xIndex, g.yTemp);
            return svg`
              ${shapes.paths.map(
                (d) => svg`<path d=${d} fill="none" stroke=${curve.color}
                  stroke-width=${curve.dashed ? 1.5 : 2} stroke-dasharray=${curve.dashed ? "3 3" : "none"}
                  stroke-linejoin="round" stroke-linecap="round"></path>`
              )}
              ${shapes.dots.map(([cx, cy]) => svg`<circle cx=${cx} cy=${cy} r="2.5" fill=${curve.color}></circle>`)}`;
          })}
          ${hover !== null
            ? svg`<line class="cursor" x1=${g.xIndex(hover)} x2=${g.xIndex(hover)} y1=${MARGIN.top} y2=${bottom}></line>
                ${visible.map((curve) =>
                  curve.values[hover] === null || curve.values[hover] === undefined
                    ? ""
                    : svg`<circle cx=${g.xIndex(hover)} cy=${g.yTemp(curve.values[hover])} r="4"
                        fill=${curve.color} stroke="var(--hw-card)" stroke-width="2"></circle>`
                )}`
            : ""}
        </svg>
      `}
      ${hover !== null ? this._renderTooltip(g, visible, hover) : ""}
    `;
  }

  _renderTooltip(g, visible, index) {
    const ms = g.startMs + index * g.bucketMs;
    const x = g.xIndex(index);
    const style = x > g.width / 2 ? `right: ${g.width - x + 8}px` : `left: ${x + 8}px`;
    return html`
      <div class="tooltip" style=${style}>
        <strong>${formatInstant(ms, this._period)}</strong>
        ${visible.map((curve) => {
          const value = curve.values[index];
          return html`<div class="tooltip-row">
            <i class="swatch-line" style="border-color: ${curve.color}; border-top-style: ${curve.dashed ? "dashed" : "solid"}"></i>
            ${curve.name}
            <span class="value">${value === null || value === undefined ? "—" : `${formatNumber(value, 1)} °C`}</span>
          </div>`;
        })}
      </div>
    `;
  }

  _renderLegend(curves) {
    return html`
      <div class="legend">
        ${curves.map(
          (curve) => html`<label>
            <input
              type="checkbox"
              .checked=${!this._hidden.has(curve.id)}
              @change=${(e) => this._toggle(curve.id, e.target.checked)}
            />
            <i class="swatch-line" style="border-color: ${curve.color}; border-top-style: ${curve.dashed ? "dashed" : "solid"}"></i>
            ${curve.name}
          </label>`
        )}
      </div>
    `;
  }

  _renderBody(curves) {
    if (this._error) {
      return html`<p class="error">${this._error}</p>`;
    }
    if (!this._data) {
      return html`<p class="hint">Chargement…</p>`;
    }
    if (!curves.length) {
      return html`<p class="hint">Aucune mesure disponible sur cette période.</p>`;
    }
    const visible = curves.filter((c) => !this._hidden.has(c.id));
    if (!visible.length) {
      return html`<p class="hint">Toutes les courbes sont masquées.</p>`;
    }
    return this._width ? this._renderChart(visible) : "";
  }

  render() {
    const curves = this._data && !this._error ? this._curves() : [];
    return html`
      <div class="header">
        <h2>Historique — toute la maison</h2>
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
      <div class="chart">${this._renderBody(curves)}</div>
      ${curves.length ? this._renderLegend(curves) : ""}
    `;
  }
}

customElements.define("heatwise-house-history", HeatwiseHouseHistory);
