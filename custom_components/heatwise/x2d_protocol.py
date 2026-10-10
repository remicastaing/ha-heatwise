"""Décodage/encodage purs du protocole X2D (Delta Dore) via un dongle RFPlayer.

Ce module ne fait aucune E/S : il ne connaît ni le port série ni le réseau
(cf. `rfplayer_client.py`). Le protocole et les valeurs ci-dessous sont
documentés et sourcés dans `docs/rfplayer-x2d.md` (essais réels du
2026-09-16/17) et dans l'API RFPlayer officielle pour l'émulation X2DGAS.
"""
from __future__ import annotations

import json
from dataclasses import dataclass

# Codes de mode X2D (émulation X2DGAS), communs à la réception et à
# l'émission — cf. docs/rfplayer-x2d.md et l'API RFPlayer.
MODE_ECO = 0
MODE_COMFORT = 3
MODE_STOP = 4
MODE_FROST = 5
MODE_AUTO = 7

MODE_NAMES: dict[int, str] = {
    MODE_ECO: "eco",
    MODE_COMFORT: "comfort",
    MODE_STOP: "stop",
    MODE_FROST: "frost",
    MODE_AUTO: "auto",
}

# Numéros des trois messages qu'envoie un thermostat X2D (cf. docs/rfplayer-x2d.md).
FUNCTION_HEATING_SPEED = 1
FUNCTION_OPERATING_MODE = 2
FUNCTION_REGULATION = 12

DEFAULT_BURST = 3


@dataclass(frozen=True, slots=True)
class X2DFrame:
    """Une trame X2D reçue, décodée."""

    x2d_id: str
    function: int
    state: int
    d0: int
    d1: int
    rf_level: int | None = None

    @property
    def level(self) -> int:
        """Octet haut de `d0` : porte le mode/niveau selon le message (cf. docs/rfplayer-x2d.md)."""
        return self.d0 >> 8

    @property
    def mode_name(self) -> str | None:
        """Nom du mode si `level` correspond à un des codes connus, sinon `None`."""
        return MODE_NAMES.get(self.level)


def decode_frame(text: str) -> X2DFrame | None:
    """Décode une ligne reçue du dongle (`ZIA33{...}` ou JSON brut) en `X2DFrame`.

    Renvoie `None` si la ligne ne contient pas de trame X2D exploitable
    (message de service du dongle, protocole différent, etc.).
    """
    if not text:
        return None
    start = text.find("{")
    if start < 0:
        return None
    try:
        payload = json.loads(text[start:])
        frame = payload["frame"]
        header = frame["header"]
        infos = frame["infos"]
        if header.get("protocolMeaning") != "X2D":
            return None
        return X2DFrame(
            x2d_id=infos["id"],
            function=int(infos["function"]),
            state=int(infos["state"]),
            d0=int(infos["d0"]),
            d1=int(infos["d1"]),
            rf_level=int(header["rfLevel"]) if "rfLevel" in header else None,
        )
    except (ValueError, KeyError, TypeError):
        return None


def encode_assoc(transmitter_id: int, *, burst: int = DEFAULT_BURST) -> str:
    """Commande d'association du dongle sur la voie TH d'un radiateur (émulation X2DGAS)."""
    return f"ZIA++ASSOC X2DGAS ID {transmitter_id} BURST {burst}"


def encode_dissoc(transmitter_id: int) -> str:
    """Commande de dissociation."""
    return f"ZIA++DISSOC X2DGAS ID {transmitter_id}"


def encode_heat_order(transmitter_id: int, *, heating: bool, mode: int = MODE_AUTO, burst: int = DEFAULT_BURST) -> str:
    """Commande de marche/arrêt de la chauffe pour un radiateur associé.

    `heating=True`/`False` correspond aux commandes `ON`/`OFF X2DGAS`
    validées manuellement (cf. docs/rfplayer-x2d.md) : elles pilotent la
    demande de chauffe (message REGULATION), `mode` porte le mode annoncé
    (message OPERATING MODE).
    """
    verb = "ON" if heating else "OFF"
    return f"ZIA++{verb} X2DGAS ID {transmitter_id} %{mode} BURST {burst}"
