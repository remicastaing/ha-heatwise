"""Stockage et logique métier des radiateurs Heatwise.

Aucun registre Home Assistant natif ne modélise un radiateur X2D (à la
différence des pièces, qui restent des Areas HA, cf. `rooms.py`) : ce
module persiste la liste des radiateurs dans un `Store` Heatwise dédié
(cf. `data-model.md` de la spec 003). Les ordres radio eux-mêmes passent
par `rfplayer_client.py`, fourni par l'appelant (`websocket_api.py`,
`__init__.py`) plutôt que relu ici depuis `hass.data`.

Un radiateur dont la pièce a été supprimée hors du panneau est « sans
pièce » (`room_id` à `None`, spec 009) : il reste enregistré, à l'arrêt,
jusqu'à ce que l'utilisateur le supprime (dissociation confirmée).
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
import logging
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_call_later
from homeassistant.helpers.storage import Store

from .const import DOMAIN, SIGNAL_RADIATORS_CHANGED
from .rfplayer_client import RFPlayerClient, RFPlayerUnreachable

_LOGGER = logging.getLogger(__name__)

STORAGE_VERSION = 1
STORAGE_KEY = f"{DOMAIN}.radiators"
MAX_TRANSMITTER_ID = 255
# FR-020 (spec 003) : 1 h fixe. Depuis la spec 011 (FR-002, FR-010), la
# chauffe manuelle est renvoyée toutes les 5 min par le `Regulator`, mais
# jamais prolongée au-delà d'1 h après la dernière action.
MANUAL_HEATING_SECONDS = 3600

_TIMERS_KEY = f"{DOMAIN}_radiator_auto_off_timers"

# Échéance d'une chauffe manuelle déléguée à l'appelant (spec 011,
# research R3) : reçoit `(radiator_id, token)`.
ExpireCallback = Callable[[str, object], Awaitable[None]]


@dataclass
class _AutoOff:
    """Minuterie d'arrêt automatique d'un radiateur. `token` identifie
    cette minuterie-là : une échéance qui attend son tour ne doit pas
    agir sur une minuterie relancée entre-temps (analyse U1)."""

    unsub: Callable[[], None]
    token: object


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


class RadiatorWithoutRoomError(Exception):
    """Radiateur « sans pièce » : jamais mis en chauffe (spec 009, FR-012b)."""


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


async def async_detach_radiators(hass: HomeAssistant, room_ids: list[str]) -> list[str]:
    """Rend « sans pièce » les radiateurs des pièces données, disparues
    (spec 009, research R2) : `room_id` passe à `None`, rien d'autre ne
    change. Retourne les `radiator_id` détachés."""
    data = await _async_load(hass)
    detached: list[str] = []
    for entry in data["radiators"]:
        if entry["room_id"] is not None and entry["room_id"] in room_ids:
            entry["room_id"] = None
            detached.append(str(entry["transmitter_id"]))
    if detached:
        await _store(hass).async_save(data)
        async_dispatcher_send(hass, SIGNAL_RADIATORS_CHANGED)
    return detached


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
    async_dispatcher_send(hass, SIGNAL_RADIATORS_CHANGED)
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
    timers: dict[str, _AutoOff] | None = hass.data.get(_TIMERS_KEY)
    if not timers:
        return
    timer = timers.pop(radiator_id, None)
    if timer is not None:
        timer.unsub()


@callback
def cancel_auto_off(hass: HomeAssistant, radiator_id: str) -> None:
    """Annule la minuterie de chauffe manuelle d'un radiateur (spec 009 :
    radiateur sans pièce arrêté par la régulation)."""
    _cancel_auto_off(hass, radiator_id)


@callback
def async_cancel_all_auto_off_timers(hass: HomeAssistant) -> None:
    """Annule toutes les minuteries de chauffe manuelle en cours.

    À appeler à l'`unload` de l'entrée, **avant** de fermer le
    `RFPlayerClient` : une minuterie planifiée par `async_set_heating`
    referme sur l'instance de client courante et ne doit jamais s'exécuter
    après sa fermeture (cf. `research.md`).
    """
    timers: dict[str, _AutoOff] | None = hass.data.pop(_TIMERS_KEY, None)
    if not timers:
        return
    for timer in timers.values():
        timer.unsub()


@callback
def has_auto_off(hass: HomeAssistant, radiator_id: str) -> bool:
    """Vrai si une chauffe manuelle du radiateur est en cours (minuterie
    d'arrêt automatique armée) — seule condition pour renvoyer « marche »
    hors régulation (spec 011, research R3)."""
    return radiator_id in hass.data.get(_TIMERS_KEY, {})


@callback
def pop_auto_off_if(hass: HomeAssistant, radiator_id: str, token: object) -> bool:
    """Retire la minuterie du radiateur seulement si c'est bien celle
    identifiée par `token` ; faux si elle a été relancée ou annulée."""
    timers: dict[str, _AutoOff] | None = hass.data.get(_TIMERS_KEY)
    timer = timers.get(radiator_id) if timers else None
    if timer is None or timer.token is not token:
        return False
    del timers[radiator_id]
    return True


async def async_set_heating(
    hass: HomeAssistant,
    client: RFPlayerClient | None,
    radiator_id: str,
    *,
    heating: bool,
    on_expire: ExpireCallback | None = None,
) -> dict[str, Any]:
    """Bascule la chauffe d'un radiateur (FR-017 à FR-020).

    `client` est le `RFPlayerClient` courant (`None` si le dongle n'est pas
    configuré, FR-022) — fourni par l'appelant plutôt que relu depuis
    `hass.data`, pour que la minuterie d'arrêt automatique planifiée ici
    referme sur l'instance en vigueur au moment de la demande.

    `on_expire` (spec 011, research R3) : si fourni, l'échéance d'1 h lui
    est déléguée avec le jeton de la minuterie — le `Regulator` exécute
    alors l'arrêt sous son verrou, sérialisé avec ses renvois. Sinon,
    l'arrêt est envoyé ici.
    """
    data = await _async_load(hass)
    entry = next(
        (r for r in data["radiators"] if str(r["transmitter_id"]) == radiator_id), None
    )
    if entry is None:
        raise RadiatorNotFoundError(radiator_id)
    if entry["room_id"] is None:
        raise RadiatorWithoutRoomError(radiator_id)
    if client is None:
        raise RFPlayerNotConfiguredError()

    transmitter_id = entry["transmitter_id"]
    await client.async_set_heating(transmitter_id, heating=heating)
    await _async_set_heating_state(hass, transmitter_id, heating)
    _cancel_auto_off(hass, radiator_id)

    if heating:
        token = object()

        async def _async_auto_off(_now: Any) -> None:
            if on_expire is not None:
                await on_expire(radiator_id, token)
                return
            if not pop_auto_off_if(hass, radiator_id, token):
                return
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
        hass.data.setdefault(_TIMERS_KEY, {})[radiator_id] = _AutoOff(unsub, token)

    return await async_get_radiator(hass, radiator_id)


async def async_apply_regulation(
    hass: HomeAssistant,
    client: RFPlayerClient | None,
    radiator_id: str,
    *,
    heating: bool,
) -> None:
    """Envoie un ordre de la régulation automatique (spec 008, FR-012,
    FR-013).

    Contrairement à `async_set_heating` (ordre manuel), aucune minuterie
    d'arrêt automatique n'est armée (FR-016). L'état `heating` n'est
    écrit qu'après envoi réussi (FR-009) ; `RFPlayerUnreachable` est
    propagée à l'appelant, qui la signale et retente plus tard.
    """
    if client is None:
        raise RFPlayerNotConfiguredError()
    transmitter_id = int(radiator_id)
    await client.async_set_heating(transmitter_id, heating=heating)
    await _async_set_heating_state(hass, transmitter_id, heating)


async def async_mark_stopped(hass: HomeAssistant, radiator_id: str) -> None:
    """Enregistre un radiateur comme arrêté sans ordre transmis : arrêt
    automatique dû mais dongle injoignable (spec 011, research R3) — le
    renvoi périodique retentera l'arrêt."""
    await _async_set_heating_state(hass, int(radiator_id), False)


async def async_cancel_room_auto_off(hass: HomeAssistant, room_id: str) -> None:
    """Annule les minuteries de chauffe manuelle des radiateurs d'une
    pièce — quand la régulation reprend la main après une suspension
    manuelle (spec 008, research R6)."""
    for radiator in await async_list_radiators(hass, room_id):
        _cancel_auto_off(hass, radiator["radiator_id"])


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
    async_dispatcher_send(hass, SIGNAL_RADIATORS_CHANGED)

    return {"deleted": True, "radio_sent": radio_sent}
