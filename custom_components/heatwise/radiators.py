"""Stockage et logique métier des radiateurs Heatwise.

Aucun registre Home Assistant natif ne modélise un radiateur X2D (à la
différence des pièces, qui restent des Areas HA, cf. `rooms.py`) : ce
module persiste la liste des radiateurs dans un `Store` Heatwise dédié
(cf. `data-model.md` de la spec 003). Les ordres radio eux-mêmes passent
par `rfplayer_client.py`, fourni par l'appelant (`websocket_api.py`,
`__init__.py`) plutôt que relu ici depuis `hass.data`.
"""
from __future__ import annotations

import logging
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_call_later
from homeassistant.helpers.storage import Store

from .const import DOMAIN
from .rfplayer_client import RFPlayerClient, RFPlayerUnreachable

_LOGGER = logging.getLogger(__name__)

STORAGE_VERSION = 1
STORAGE_KEY = f"{DOMAIN}.radiators"
MAX_TRANSMITTER_ID = 255
MANUAL_HEATING_SECONDS = 3600  # FR-020 : 1h fixe, jamais renouvelée (FR-019)

_TIMERS_KEY = f"{DOMAIN}_radiator_auto_off_timers"


class InvalidRadiatorNameError(Exception):
    """Nom vide (FR-010)."""


class RadiatorNameAlreadyUsedError(Exception):
    """Nom déjà utilisé par un autre radiateur Heatwise (FR-010)."""


class TransmitterIdAlreadyUsedError(Exception):
    """Identité radio déjà attribuée à un radiateur enregistré."""


class NoTransmitterIdAvailableError(Exception):
    """Les 256 identités radio (0-255) sont déjà utilisées."""


class RadiatorNotFoundError(Exception):
    """`radiator_id` inconnu."""


class RFPlayerNotConfiguredError(Exception):
    """Aucun port RFPlayer configuré (FR-022)."""


def _store(hass: HomeAssistant) -> Store:
    return Store(hass, STORAGE_VERSION, STORAGE_KEY)


async def _async_load(hass: HomeAssistant) -> dict[str, Any]:
    data = await _store(hass).async_load()
    if data is None:
        data = {"radiators": []}
    # `reserved_transmitter_ids` (spec 004) est facultative : un `Store`
    # écrit par la spec 003 n'en a pas encore (compatibilité, pas de
    # migration).
    data.setdefault("reserved_transmitter_ids", [])
    return data


def _normalize(name: str) -> str:
    return " ".join(name.strip().split())


def _assemble(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "radiator_id": str(entry["transmitter_id"]),
        "name": entry["name"],
        "room_id": entry["room_id"],
        "heating": entry["heating"],
    }


async def async_list_radiators(
    hass: HomeAssistant, room_id: str | None = None
) -> list[dict[str, Any]]:
    """Liste les radiateurs, éventuellement filtrés sur une pièce (FR-014)."""
    data = await _async_load(hass)
    radiators = data["radiators"]
    if room_id is not None:
        radiators = [r for r in radiators if r["room_id"] == room_id]
    return [_assemble(r) for r in radiators]


async def async_get_radiator(hass: HomeAssistant, radiator_id: str) -> dict[str, Any]:
    data = await _async_load(hass)
    for entry in data["radiators"]:
        if str(entry["transmitter_id"]) == radiator_id:
            return _assemble(entry)
    raise RadiatorNotFoundError(radiator_id)


async def async_allocate_transmitter_id(hass: HomeAssistant) -> int:
    """Alloue le plus petit entier 0-255 pas encore utilisé par un
    radiateur enregistré (cf. `docs/rfplayer-x2d.md`), ni réservé par une
    suppression sans dissociation transmise (FR-008 de la spec 004,
    principe I — cf. `research.md` R5)."""
    data = await _async_load(hass)
    used = {r["transmitter_id"] for r in data["radiators"]}
    used |= set(data["reserved_transmitter_ids"])
    for candidate in range(MAX_TRANSMITTER_ID + 1):
        if candidate not in used:
            return candidate
    raise NoTransmitterIdAvailableError()


async def compute_default_name(hass: HomeAssistant, room_name: str) -> str:
    """Calcule « <room_name> n°x », x étant le plus petit entier ≥ 1 tel
    que ce nom ne soit pas déjà utilisé par un radiateur Heatwise, toutes
    pièces confondues (FR-008, mêmes règles que la validation FR-010)."""
    data = await _async_load(hass)
    used_names = {_normalize(r["name"]) for r in data["radiators"]}
    index = 1
    while True:
        candidate = f"{room_name} n°{index}"
        if _normalize(candidate) not in used_names:
            return candidate
        index += 1


async def async_save_radiator(
    hass: HomeAssistant, transmitter_id: int, room_id: str, name: str
) -> dict[str, Any]:
    """Enregistre un nouveau radiateur après appairage confirmé (FR-009 à
    FR-011)."""
    trimmed = name.strip()
    if not trimmed:
        raise InvalidRadiatorNameError()

    data = await _async_load(hass)
    normalized = _normalize(trimmed)
    for entry in data["radiators"]:
        if entry["transmitter_id"] == transmitter_id:
            raise TransmitterIdAlreadyUsedError()
        if _normalize(entry["name"]) == normalized:
            raise RadiatorNameAlreadyUsedError()

    entry: dict[str, Any] = {
        "transmitter_id": transmitter_id,
        "name": trimmed,
        "room_id": room_id,
        "heating": False,
    }
    data["radiators"].append(entry)
    await _store(hass).async_save(data)
    return _assemble(entry)


async def _async_set_heating_state(
    hass: HomeAssistant, transmitter_id: int, heating: bool
) -> None:
    data = await _async_load(hass)
    for entry in data["radiators"]:
        if entry["transmitter_id"] == transmitter_id:
            entry["heating"] = heating
            break
    await _store(hass).async_save(data)


@callback
def _cancel_auto_off(hass: HomeAssistant, radiator_id: str) -> None:
    timers: dict[str, Any] | None = hass.data.get(_TIMERS_KEY)
    if not timers:
        return
    unsub = timers.pop(radiator_id, None)
    if unsub is not None:
        unsub()


@callback
def async_cancel_all_auto_off_timers(hass: HomeAssistant) -> None:
    """Annule toutes les minuteries de chauffe manuelle en cours.

    À appeler à l'`unload` de l'entrée, **avant** de fermer le
    `RFPlayerClient` : une minuterie planifiée par `async_set_heating`
    referme sur l'instance de client courante et ne doit jamais s'exécuter
    après sa fermeture (cf. `research.md`).
    """
    timers: dict[str, Any] | None = hass.data.pop(_TIMERS_KEY, None)
    if not timers:
        return
    for unsub in timers.values():
        unsub()


async def async_set_heating(
    hass: HomeAssistant,
    client: RFPlayerClient | None,
    radiator_id: str,
    *,
    heating: bool,
) -> dict[str, Any]:
    """Bascule la chauffe d'un radiateur (FR-017 à FR-020).

    `client` est le `RFPlayerClient` courant (`None` si le dongle n'est pas
    configuré, FR-022) — fourni par l'appelant plutôt que relu depuis
    `hass.data`, pour que la minuterie d'arrêt automatique planifiée ici
    referme sur l'instance en vigueur au moment de la demande.
    """
    data = await _async_load(hass)
    entry = next(
        (r for r in data["radiators"] if str(r["transmitter_id"]) == radiator_id), None
    )
    if entry is None:
        raise RadiatorNotFoundError(radiator_id)
    if client is None:
        raise RFPlayerNotConfiguredError()

    transmitter_id = entry["transmitter_id"]
    await client.async_set_heating(transmitter_id, heating=heating)
    await _async_set_heating_state(hass, transmitter_id, heating)
    _cancel_auto_off(hass, radiator_id)

    if heating:

        async def _async_auto_off(_now: Any) -> None:
            timers: dict[str, Any] | None = hass.data.get(_TIMERS_KEY)
            if timers is not None:
                timers.pop(radiator_id, None)
            try:
                await client.async_set_heating(transmitter_id, heating=False)
            except RFPlayerUnreachable:
                _LOGGER.warning(
                    "Dongle injoignable : impossible d'envoyer l'ordre "
                    "d'arrêt automatique au radiateur %s",
                    radiator_id,
                )
            await _async_set_heating_state(hass, transmitter_id, False)

        unsub = async_call_later(hass, MANUAL_HEATING_SECONDS, _async_auto_off)
        hass.data.setdefault(_TIMERS_KEY, {})[radiator_id] = unsub

    return await async_get_radiator(hass, radiator_id)


async def async_force_stop_all(hass: HomeAssistant, client: RFPlayerClient | None) -> None:
    """Force tous les radiateurs à l'arrêt (FR-021, principe I) — appelé à
    chaque démarrage de Home Assistant, que le dongle soit joignable ou
    non ; l'état persisté passe à « éteint » même si l'ordre radio n'a pas
    pu être envoyé (le récepteur coupe de lui-même son relais après 1h
    sans trame, cf. `research.md`)."""
    data = await _async_load(hass)
    changed = False
    for entry in data["radiators"]:
        transmitter_id = entry["transmitter_id"]
        if client is not None:
            try:
                await client.async_set_heating(transmitter_id, heating=False)
            except RFPlayerUnreachable:
                _LOGGER.warning(
                    "Dongle injoignable : impossible d'envoyer l'ordre "
                    "d'arrêt au radiateur %s au démarrage",
                    transmitter_id,
                )
        if entry["heating"]:
            entry["heating"] = False
            changed = True
    if changed:
        await _store(hass).async_save(data)


async def async_delete_radiator(
    hass: HomeAssistant,
    client: RFPlayerClient | None,
    radiator_id: str,
    *,
    force: bool = False,
) -> dict[str, bool]:
    """Supprime un radiateur (spec 004, FR-004 à FR-006).

    Envoie d'abord un ordre d'arrêt, puis un ordre de dissociation
    (jamais l'inverse : principe I, cf. `research.md` R1) avant de
    retirer le radiateur du `Store`. Sans `force`, toute
    `RFPlayerUnreachable` (dongle injoignable) ou l'absence de client
    (`RFPlayerNotConfiguredError`, dongle non configuré) interrompt la
    suppression sans rien modifier au-delà de l'éventuel arrêt déjà
    transmis (R3). Avec `force`, les ordres radio sont tentés en
    best-effort : le radiateur est retiré même s'ils échouent, et si la
    dissociation n'a pas pu être transmise, son identité radio est
    réservée pour ne jamais être réattribuée (FR-008, R5).
    """
    data = await _async_load(hass)
    entry = next(
        (r for r in data["radiators"] if str(r["transmitter_id"]) == radiator_id), None
    )
    if entry is None:
        raise RadiatorNotFoundError(radiator_id)

    transmitter_id = entry["transmitter_id"]
    radio_sent = True
    dissoc_sent = False

    if client is None:
        if not force:
            raise RFPlayerNotConfiguredError()
        radio_sent = False
    else:
        try:
            await client.async_set_heating(transmitter_id, heating=False)
        except RFPlayerUnreachable:
            if not force:
                raise
            radio_sent = False
            _LOGGER.warning(
                "Dongle injoignable : impossible d'envoyer l'ordre d'arrêt "
                "au radiateur %s avant sa suppression",
                radiator_id,
            )
        else:
            # FR-005/R4 : annuler la minuterie dès que l'arrêt est
            # transmis, avant de tenter la dissociation — un arrêt
            # automatique orphelin ne doit jamais s'exécuter après.
            await _async_set_heating_state(hass, transmitter_id, False)
            _cancel_auto_off(hass, radiator_id)

        try:
            await client.async_unpair(transmitter_id)
        except RFPlayerUnreachable:
            if not force:
                raise
            radio_sent = False
            _LOGGER.warning(
                "Dongle injoignable : impossible de dissocier le "
                "radiateur %s avant sa suppression",
                radiator_id,
            )
        else:
            dissoc_sent = True

    _cancel_auto_off(hass, radiator_id)

    data = await _async_load(hass)
    data["radiators"] = [
        r for r in data["radiators"] if r["transmitter_id"] != transmitter_id
    ]
    if not dissoc_sent and transmitter_id not in data["reserved_transmitter_ids"]:
        data["reserved_transmitter_ids"].append(transmitter_id)
    await _store(hass).async_save(data)

    return {"deleted": True, "radio_sent": radio_sent}
