import { LitElement, html, css } from "./vendor/lit-core.min.js";
import { BANDS, PERIODS, loadShowOutdoor, storeShowOutdoor } from "./heatwise-history.js";

// Spec 013 (US4, révisée le 2026-11-08) : historique de toute la maison.
// Un graphique par pièce, les uns sous les autres, dans l'ordre du panneau :
// chacun est le graphique d'une pièce (spec 010, `heatwise-history`) en mode
// compact ; la période et l'affichage de l'extérieur sont communs.

class HeatwiseHouseHistory extends LitElement {
  static properties = {
    hass: { attribute: false },
    rooms: { attribute: false },
    _period: { state: true },
    _showOutdoor: { state: true },
  };

  static styles = css`
    :host {
      display: block;
      box-sizing: border-box;
      --hw-border: var(--divider-color, #e5e3de);
      --hw-card: var(--card-background-color, #ffffff);
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
    .controls {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--primary-background-color, #f7f6f3);
      padding-bottom: 8px;
    }
    .periods {
      display: inline-flex;
      border: 1px solid var(--hw-border);
      border-radius: 8px;
      overflow: hidden;
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
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 14px;
      margin-top: 10px;
      font-size: 12px;
      color: var(--hw-text-secondary);
    }
    .legend span,
    .legend label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .legend label {
      cursor: pointer;
    }
    .legend input {
      margin: 0;
    }
    .swatch-line {
      width: 16px;
      height: 0;
      border-top: 2px solid;
    }
    .swatch-band {
      width: 12px;
      height: 12px;
      border-radius: 3px;
    }
    .room {
      margin-top: 16px;
    }
    .room h3 {
      margin: 0 0 6px;
      font-size: 15px;
      font-weight: 600;
    }
    .hint {
      color: var(--hw-text-secondary);
      font-size: 13px;
    }
  `;

  constructor() {
    super();
    this.rooms = [];
    this._period = "24h";
    this._showOutdoor = loadShowOutdoor();
  }

  _setPeriod(period) {
    this._period = period;
  }

  _toggleOutdoor(event) {
    this._showOutdoor = event.target.checked;
    storeShowOutdoor(this._showOutdoor);
  }

  _close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }

  _renderLegend() {
    return html`
      <div class="legend">
        <span><i class="swatch-line" style="border-color: var(--hw-temperature)"></i>Température</span>
        <span><i class="swatch-line" style="border-color: var(--hw-humidity)"></i>Humidité</span>
        <span><i class="swatch-line" style="border-color: var(--hw-target); border-top-style: dashed"></i>Consigne</span>
        <label>
          <input type="checkbox" .checked=${this._showOutdoor} @change=${this._toggleOutdoor} />
          <i class="swatch-line" style="border-color: var(--hw-outdoor); border-top-style: dotted"></i>Extérieur
        </label>
        ${Object.values(BANDS).map(
          (band) => html`<span><i class="swatch-band" style="background: ${band.color}"></i>${band.label}</span>`
        )}
      </div>
    `;
  }

  render() {
    const rooms = this.rooms || [];
    return html`
      <div class="header">
        <h2>Historique — toute la maison</h2>
        <button class="icon-button" aria-label="Fermer" @click=${this._close}>
          <ha-icon icon="mdi:close"></ha-icon>
        </button>
      </div>
      <div class="controls">
        <div class="periods" role="group" aria-label="Période">
          ${PERIODS.map(
            (p) => html`
              <button
                class=${p.id === this._period ? "active" : ""}
                aria-pressed=${p.id === this._period}
                @click=${() => this._setPeriod(p.id)}
              >
                ${p.label}
              </button>
            `
          )}
        </div>
        ${this._renderLegend()}
      </div>
      ${rooms.length
        ? rooms.map(
            (room) => html`
              <section class="room">
                <h3>${room.name}</h3>
                <heatwise-history
                  compact
                  .hass=${this.hass}
                  .roomId=${room.room_id}
                  .roomName=${room.name}
                  .period=${this._period}
                  .showOutdoor=${this._showOutdoor}
                ></heatwise-history>
              </section>
            `
          )
        : html`<p class="hint">Aucune pièce.</p>`}
    `;
  }
}

customElements.define("heatwise-house-history", HeatwiseHouseHistory);
