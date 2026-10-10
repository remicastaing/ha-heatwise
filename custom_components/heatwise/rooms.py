"""Assemblage des pièces affichées par le panneau Heatwise.

Une « pièce » Heatwise est directement une Area Home Assistant (fusion
room_id/area_id, cf. specs/002-heatwise-panel-pieces/research.md). Ce
module ne stocke rien de propre à Heatwise : il lit les registres HA
existants (Area registry, Entity registry, states), le stockage des
radiateurs (`radiators.py`, spec 003) pour `has_radiator`, et celui de la
programmation (`schedules_store.py`, spec 005) pour `target_temperature`,
les sondes (`sensors.py`, spec 006) pour l'humidité, la pile et la
péremption, et retourne la forme documentée dans data-model.md / contracts/websocket-api.md.
"""
from __future__ import annotations

from typing import Any

from homeassistant.const import STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.util import dt as dt_util

from . import radiators as radiators_module
from . import schedule as schedule_module
from . import schedules_store
from . import sensors as sensors_module


class InvalidRoomNameError(Exception):
    """Levée quand le nom fourni pour créer une pièce est vide."""


def _assemble_room(
    hass: HomeAssistant,
    area: ar.AreaEntry,
    *,
    has_radiator: bool = False,
    target_temperature: float | None = None,
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
        # Consigne affichée uniquement (spec 005, FR-027) : la plage en
        # cours de la programmation applicable, ou la consigne hors
        # plage, pour les pièces avec radiateur ; aucun pilotage des
        # radiateurs n'en découle (FR-029). `None` sans radiateur.
        "target_temperature": target_temperature,
    }


async def _async_assemble_areas(
    hass: HomeAssistant, areas: list[ar.AreaEntry]
) -> list[dict[str, Any]]:
    """Assemble les Areas données ; partagé par `list_rooms` et
    `async_get_room`."""
    all_radiators = await radiators_module.async_list_radiators(hass)
    room_ids_with_radiator = {r["room_id"] for r in all_radiators}

    all_schedules = await schedules_store.async_get_all(hass)
    settings = all_schedules["settings"]
    now = dt_util.now()

    def _target_temperature(area_id: str) -> float | None:
        if area_id not in room_ids_with_radiator:
            return None
        room_schedule = all_schedules["rooms"].get(area_id, schedule_module.empty_room_schedule())
        return schedule_module.current_target(room_schedule, settings, now)

    return [
        _assemble_room(
            hass,
            area,
            has_radiator=area.id in room_ids_with_radiator,
            target_temperature=_target_temperature(area.id),
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
    espaces superflus (FR-011). Aucune contrainte d'unicité : Home
    Assistant autorise déjà des noms d'Area identiques (cf. Edge Cases de
    spec.md). Une pièce nouvellement créée n'a par définition aucun
    radiateur.
    """
    trimmed_name = name.strip()
    if not trimmed_name:
        raise InvalidRoomNameError("Le nom de la pièce est obligatoire.")

    area = ar.async_get(hass).async_create(trimmed_name)
    return _assemble_room(hass, area, has_radiator=False)
