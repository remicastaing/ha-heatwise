"""Stockage de la programmation Heatwise (spec 005).

Persiste les paramètres généraux et la programmation de chaque pièce
dans un `Store` Heatwise dédié, `heatwise.schedules` (cf.
`data-model.md`). La logique de modification elle-même (peinture,
copies, parité...) vit dans `schedule.py`, module pur ; ce module ne
fait qu'orchestrer chargement, verrouillage, sauvegarde et l'émission de
l'événement `heatwise_schedule_updated`.
"""
from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from . import schedule as schedule_module
from .const import DOMAIN, EVENT_SCHEDULE_UPDATED

STORAGE_VERSION = 1
STORAGE_KEY = f"{DOMAIN}.schedules"

_LOCK_KEY = f"{DOMAIN}_schedules_lock"


def _store(hass: HomeAssistant) -> Store:
    return Store(hass, STORAGE_VERSION, STORAGE_KEY)


def _default_settings() -> dict[str, Any]:
    return {
        "default_temperature": schedule_module.DEFAULT_TEMPERATURE,
        "vacation_mode": False,
    }


async def _async_load(hass: HomeAssistant) -> dict[str, Any]:
    data = await _store(hass).async_load()
    if data is None:
        data = {"settings": _default_settings(), "rooms": {}}
    data.setdefault("settings", _default_settings())
    data.setdefault("rooms", {})
    return data


def _lock(hass: HomeAssistant) -> asyncio.Lock:
    """Verrou unique protégeant les mutations du Store (chargement →
    calcul → sauvegarde), pour qu'une requête n'écrase jamais une
    autre (`data-model.md` R8)."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    lock = domain_data.get(_LOCK_KEY)
    if lock is None:
        lock = asyncio.Lock()
        domain_data[_LOCK_KEY] = lock
    return lock


async def async_get_settings(hass: HomeAssistant) -> dict[str, Any]:
    data = await _async_load(hass)
    return dict(data["settings"])


async def async_get_room_schedule(hass: HomeAssistant, room_id: str) -> dict[str, Any]:
    """Programmation d'une pièce, ou une programmation vide si la pièce
    n'a encore rien enregistré."""
    data = await _async_load(hass)
    entry = data["rooms"].get(room_id)
    if entry is None:
        return schedule_module.empty_room_schedule()
    return schedule_module.copy_room_schedule(entry)


async def async_get_all(hass: HomeAssistant) -> dict[str, Any]:
    """Paramètres et programmations de toutes les pièces connues du
    Store (pour `rooms.py`, qui calcule `target_temperature` en une
    seule lecture pour toutes les pièces)."""
    data = await _async_load(hass)
    return {
        "settings": dict(data["settings"]),
        "rooms": {
            room_id: schedule_module.copy_room_schedule(entry)
            for room_id, entry in data["rooms"].items()
        },
    }


async def async_mutate_rooms(
    hass: HomeAssistant,
    room_ids: list[str],
    fn: Callable[[dict[str, dict[str, Any]]], Awaitable[dict[str, dict[str, Any]]]]
    | Callable[[dict[str, dict[str, Any]]], dict[str, dict[str, Any]]],
) -> dict[str, dict[str, Any]]:
    """Modifie atomiquement la programmation d'une ou plusieurs pièces.

    Sous verrou : charge le Store, passe à `fn` un dict `{room_id:
    RoomSchedule}` (copie profonde, programmation vide si absente) pour
    chaque `room_id` de `room_ids`, attend le dict modifié en retour,
    l'écrit et sauvegarde, puis émet `heatwise_schedule_updated` avec
    `{"room_ids": room_ids}`. Si `fn` lève, rien n'est sauvegardé ni
    émis.
    """
    async with _lock(hass):
        data = await _async_load(hass)
        current = {
            room_id: schedule_module.copy_room_schedule(data["rooms"][room_id])
            if room_id in data["rooms"]
            else schedule_module.empty_room_schedule()
            for room_id in room_ids
        }
        result = fn(current)
        if asyncio.iscoroutine(result):
            result = await result

        for room_id, room_schedule in result.items():
            data["rooms"][room_id] = room_schedule
        await _store(hass).async_save(data)

    hass.bus.async_fire(EVENT_SCHEDULE_UPDATED, {"room_ids": room_ids})
    return {room_id: schedule_module.copy_room_schedule(result[room_id]) for room_id in room_ids}


async def async_update_settings(hass: HomeAssistant, **changes: Any) -> dict[str, Any]:
    """Modifie un ou plusieurs paramètres généraux (FR-010 à FR-011,
    FR-022). Valide `default_temperature` si fourni (FR-008). Émet
    `heatwise_schedule_updated` avec `{"room_ids": None}` (concerne
    toute la maison)."""
    if "default_temperature" in changes and changes["default_temperature"] is not None:
        schedule_module.validate_temperature(changes["default_temperature"])

    async with _lock(hass):
        data = await _async_load(hass)
        for key, value in changes.items():
            if value is not None:
                data["settings"][key] = value
        await _store(hass).async_save(data)
        settings = dict(data["settings"])

    hass.bus.async_fire(EVENT_SCHEDULE_UPDATED, {"room_ids": None})
    return settings
