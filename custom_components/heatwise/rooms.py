"""Assemblage des pièces affichées par le panneau Heatwise.

Une « pièce » Heatwise est directement une Area Home Assistant (fusion
room_id/area_id, cf. specs/002-heatwise-panel-pieces/research.md). Ce
module ne stocke rien de propre à Heatwise : il lit les registres HA
existants (Area registry, Entity registry, states), le stockage des
radiateurs (`radiators.py`, spec 003) pour `has_radiator`, et celui de la
programmation (`schedules_store.py`, spec 005) pour `target_temperature`,
les sondes (`sensors.py`, spec 006) pour l'humidité, la pile et la
péremption, l'état de la régulation (`regulator.py`, spec 008), et retourne la forme documentée dans data-model.md / contracts/websocket-api.md.
"""
from __future__ import annotations

from typing import Any

from homeassistant.const import STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.util import dt as dt_util

from . import radiators as radiators_module
from . import regulator as regulator_module
from . import schedule as schedule_module
from . import schedules_store
from . import sensors as sensors_module
from .sensors import RoomNotFoundError  # partagée avec l'association de sonde


class InvalidRoomNameError(Exception):
    """Levée quand le nom fourni pour créer ou renommer une pièce est vide."""


class RoomHasRadiatorsError(Exception):
    """Suppression refusée : la pièce a encore des radiateurs, à supprimer
    d'abord (spec 009, FR-008)."""

    def __init__(self, names: list[str]) -> None:
        super().__init__(", ".join(names))
        self.names = names


class RoomNameTakenError(Exception):
    """Nom déjà porté par une autre zone, selon la règle native de Home
    Assistant (casse et espaces ignorés) — spec 009, research R1."""


def _assemble_room(
    hass: HomeAssistant,
    area: ar.AreaEntry,
    *,
    has_radiator: bool = False,
    heating: bool = False,
    target_temperature: float | None = None,
    regulation: dict[str, Any] | None = None,
) -> dict[str, Any]:
    # Home Assistant expose nativement un capteur de température par Area
    # (`AreaEntry.temperature_entity_id`) — pas besoin de le rechercher
    # nous-mêmes dans l'entity registry (cf. research.md, corrigé lors de
    # l'implémentation T015).
    entity_id = area.temperature_entity_id
    has_sensor = entity_id is not None

    state = hass.states.get(entity_id) if has_sensor else None
    current_temperature: str | float | None = None
    if has_sensor:
        if state is None or state.state in (STATE_UNKNOWN, STATE_UNAVAILABLE):
            current_temperature = "unknown"
        else:
            current_temperature = state.state

    return {
        "room_id": area.id,
        "name": area.name,
        "icon": area.icon,
        "has_sensor": has_sensor,
        # Exposé (contrairement à la décision initiale) pour permettre au
        # panneau de suivre les changements d'état via `hass.states` sans
        # ré-appeler `heatwise/list_rooms` (FR-014) — cf. research.md.
        "temperature_entity_id": entity_id,
        "current_temperature": current_temperature,
        # Spec 006 : la sonde (température, humidité) est portée par les
        # réglages natifs de l'Area ; la pile est celle de l'appareil de
        # la sonde. `sensor_stale` applique la règle des 60 min
        # (`sensors.is_stale`) car `last_reported` n'est pas transmis au
        # navigateur (research R6).
        "humidity_entity_id": area.humidity_entity_id,
        "battery_entity_id": (
            sensors_module.battery_entity_for(hass, entity_id) if has_sensor else None
        ),
        "temperature_last_reported": (
            state.last_reported.isoformat() if state is not None else None
        ),
        "sensor_stale": sensors_module.is_stale(state, dt_util.utcnow()),
        "sensor_missing": has_sensor and state is None,
        "has_radiator": has_radiator,
        # Spec 011 : au moins un radiateur de la pièce en chauffe (ordre
        # transmis) — le panneau en dérive « Chauffe manuelle jusqu'à… ».
        "heating": heating,
        # Consigne affichée uniquement (spec 005, FR-027) : la plage en
        # cours de la programmation applicable, ou la consigne hors
        # plage, pour les pièces avec radiateur ; aucun pilotage des
        # radiateurs n'en découle (FR-029). `None` sans radiateur.
        "target_temperature": target_temperature,
        # Spec 008 : état de la régulation automatique (statut, raison,
        # fin de suspension manuelle) ; `None` sans radiateur.
        "regulation": regulation,
    }


async def _async_assemble_areas(
    hass: HomeAssistant, areas: list[ar.AreaEntry]
) -> list[dict[str, Any]]:
    """Assemble les Areas données ; partagé par `list_rooms` et
    `async_get_room`."""
    all_radiators = await radiators_module.async_list_radiators(hass)
    room_ids_with_radiator = {r["room_id"] for r in all_radiators}
    room_ids_with_radiator.discard(None)  # radiateurs sans pièce (spec 009)
    room_ids_heating = {r["room_id"] for r in all_radiators if r["heating"]}

    all_schedules = await schedules_store.async_get_all(hass)
    settings = all_schedules["settings"]
    now = dt_util.now()

    def _effective(area_id: str) -> regulator_module.EffectiveTarget:
        room_schedule = all_schedules["rooms"].get(area_id, schedule_module.empty_room_schedule())
        return regulator_module.effective_target(hass, area_id, room_schedule, settings, now)

    def _target_temperature(area_id: str) -> float | None:
        if area_id not in room_ids_with_radiator:
            return None
        # Spec 012 : consigne effective, consigne temporaire comprise.
        return _effective(area_id).temperature

    regulator = regulator_module.get_regulator(hass)

    def _regulation(area_id: str) -> dict[str, Any] | None:
        if area_id not in room_ids_with_radiator:
            return None
        status = (
            dict(regulator_module.DEFAULT_STATUS)
            if regulator is None
            else regulator.room_status(area_id)
        )
        # Provenance recalculée à l'instant, comme la consigne affichée.
        status["target_source"] = _effective(area_id).source
        return status

    return [
        _assemble_room(
            hass,
            area,
            has_radiator=area.id in room_ids_with_radiator,
            heating=area.id in room_ids_heating,
            target_temperature=_target_temperature(area.id),
            regulation=_regulation(area.id),
        )
        for area in areas
    ]


async def list_rooms(hass: HomeAssistant) -> list[dict[str, Any]]:
    """Liste toutes les pièces (Areas HA), assemblées pour l'affichage.

    `has_radiator` reflète l'existence réelle d'au moins un radiateur
    rattaché (spec 003, FR-013) ; `target_temperature` la consigne
    courante de sa programmation (spec 005, FR-027), lues depuis
    `radiators.py` et `schedules_store.py`.
    """
    return await _async_assemble_areas(
        hass, list(ar.async_get(hass).async_list_areas())
    )


async def async_list_orphan_radiators(hass: HomeAssistant) -> list[dict[str, Any]]:
    """Radiateurs dont la pièce a disparu hors du panneau (spec 009,
    FR-012a), affichés dans l'encart « Radiateurs sans pièce »."""
    return [
        r for r in await radiators_module.async_list_radiators(hass) if r["room_id"] is None
    ]


async def async_get_room(hass: HomeAssistant, room_id: str) -> dict[str, Any] | None:
    """Une seule pièce assemblée, ou `None` si l'Area n'existe pas."""
    area = ar.async_get(hass).async_get_area(room_id)
    if area is None:
        return None
    [room] = await _async_assemble_areas(hass, [area])
    return room


def create_room(hass: HomeAssistant, name: str) -> dict[str, Any]:
    """Crée une nouvelle pièce (Area HA) et retourne sa forme assemblée.

    Lève `InvalidRoomNameError` si `name` est vide après suppression des
    espaces superflus (FR-011), `RoomNameTakenError` si une zone porte
    déjà ce nom : Home Assistant refuse les doublons (casse et espaces
    ignorés), contrairement à ce que supposait la spec 002 (spec 009,
    research R1). Une pièce nouvellement créée n'a par définition aucun
    radiateur.
    """
    trimmed_name = name.strip()
    if not trimmed_name:
        raise InvalidRoomNameError("Le nom de la pièce est obligatoire.")

    try:
        area = ar.async_get(hass).async_create(trimmed_name)
    except ValueError as err:
        raise RoomNameTakenError(trimmed_name) from err
    return _assemble_room(hass, area, has_radiator=False)


async def async_rename_room(hass: HomeAssistant, room_id: str, name: str) -> dict[str, Any]:
    """Renomme la zone elle-même (spec 009, FR-001 à FR-005) : le panneau
    et Paramètres → Zones affichent le même nom. Radiateurs,
    programmation et sonde sont rattachés à l'identifiant, pas au nom,
    et restent inchangés ; aucun appareil n'est renommé."""
    trimmed_name = name.strip()
    if not trimmed_name:
        raise InvalidRoomNameError("Le nom de la pièce est obligatoire.")
    area_registry = ar.async_get(hass)
    if area_registry.async_get_area(room_id) is None:
        raise RoomNotFoundError(room_id)
    try:
        area_registry.async_update(room_id, name=trimmed_name)
    except ValueError as err:
        raise RoomNameTakenError(trimmed_name) from err
    room = await async_get_room(hass, room_id)
    assert room is not None
    return room


async def async_delete_room(hass: HomeAssistant, room_id: str) -> None:
    """Supprime une pièce depuis le panneau (spec 009, FR-006 à FR-011).

    Refusée tant que la pièce a des radiateurs (FR-008) : aucun ordre
    radio n'est donc jamais envoyé ici (FR-009). Sinon, la programmation
    est retirée puis la zone supprimée ; Home Assistant détache lui-même
    appareils et entités de la zone (la sonde reste, sans zone, FR-011)
    et la réconciliation du `Regulator`, déclenchée par
    `area_registry_updated`, oublie l'état de régulation (research R6).
    """
    area_registry = ar.async_get(hass)
    if area_registry.async_get_area(room_id) is None:
        raise RoomNotFoundError(room_id)
    room_radiators = await radiators_module.async_list_radiators(hass, room_id)
    if room_radiators:
        raise RoomHasRadiatorsError([r["name"] for r in room_radiators])

    await schedules_store.async_remove_rooms(hass, [room_id])
    # La zone a pu disparaître pendant la mise à jour de la programmation.
    if area_registry.async_get_area(room_id) is not None:
        area_registry.async_delete(room_id)
