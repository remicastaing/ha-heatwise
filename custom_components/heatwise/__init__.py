"""Heatwise — panneau de gestion des pièces et pilotage des radiateurs
(spec 002 + spec 003).

`async_setup_entry` enregistre le panneau personnalisé, l'API websocket, et
ouvre la connexion série au dongle RFPlayer si un port est configuré
(FR-022) — l'absence de port ne fait pas échouer le setup (installation
antérieure à la spec 003, cf. `research.md`) : le panneau et les pièces
restent disponibles, seules les commandes radiateurs répondent
`rfplayer_not_configured`. Au démarrage, tous les radiateurs déjà
enregistrés sont forcés à l'arrêt (FR-021, principe I de la constitution),
puis la régulation automatique démarre (spec 008, `regulator.py`) : elle
ne rallume une pièce que sur une mesure valide de sa sonde.
"""
from __future__ import annotations

from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from . import radiators, websocket_api
from .const import DOMAIN
from .regulator import Regulator
from .rfplayer_client import RFPlayerClient

PANEL_DIR = Path(__file__).parent / "panel"
STATIC_URL_PREFIX = "/heatwise_static"
PANEL_JS_URL = f"{STATIC_URL_PREFIX}/heatwise-panel.js"
PANEL_URL_PATH = "heatwise"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    await hass.http.async_register_static_paths(
        [StaticPathConfig(STATIC_URL_PREFIX, str(PANEL_DIR), cache_headers=False)]
    )

    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name="heatwise-panel",
        module_url=PANEL_JS_URL,
        sidebar_title="Heatwise",
        sidebar_icon="mdi:radiator",
        require_admin=True,
    )

    websocket_api.async_register_commands(hass)

    port = entry.data.get("port")
    client = RFPlayerClient(port) if port else None
    if client is not None:
        await client.async_connect()
    hass.data.setdefault(DOMAIN, {})["client"] = client

    # Sécurité (principe I, FR-021) : au démarrage, tous les radiateurs
    # déjà enregistrés repartent éteints, qu'ils aient été en chauffe ou
    # non avant l'arrêt de Home Assistant.
    await radiators.async_force_stop_all(hass, client)

    # Spec 008 : la régulation ne reprend qu'après cet arrêt (FR-011).
    regulator = Regulator(hass, client)
    hass.data[DOMAIN]["regulator"] = regulator
    await regulator.async_start()

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    try:
        frontend.async_remove_panel(hass, PANEL_URL_PATH)
    except KeyError:
        pass

    domain_data = hass.data.get(DOMAIN)
    # Spec 008 (research R7) : arrêter la régulation, puis les radiateurs
    # (best-effort), pour qu'aucun ne chauffe sans pilote après le
    # déchargement.
    regulator = domain_data.pop("regulator", None) if domain_data else None
    if regulator is not None:
        await regulator.async_stop()
        await radiators.async_force_stop_all(hass, regulator.client)

    # Annuler les minuteries de chauffe manuelle *avant* de fermer le
    # client : une minuterie planifiée par `radiators.async_set_heating`
    # referme sur l'instance de client courante et ne doit jamais
    # s'exécuter après sa fermeture (cf. research.md).
    radiators.async_cancel_all_auto_off_timers(hass)

    if domain_data is not None:
        client = domain_data.pop("client", None)
        if client is not None:
            await client.async_close()

    return True
