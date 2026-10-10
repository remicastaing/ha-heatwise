"""Sondes de température et d'hygrométrie associées aux pièces (spec 006).

L'association pièce ↔ sonde est stockée uniquement dans les champs
natifs de l'Area Home Assistant (`temperature_entity_id`,
`humidity_entity_id`) : Heatwise ne tient aucun registre propre (cf.
specs/006-heatwise-sondes/research.md, R1). Ce module lit les registres
HA pour proposer les capteurs, applique les règles d'unicité (R5) et la
règle de péremption (R6), et écrit l'association.

Il n'importe pas `rooms.py` (R6bis) : les fonctions d'écriture ne
renvoient rien, c'est `websocket_api.py` qui assemble la pièce.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from homeassistant.const import STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import HomeAssistant, State, callback
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

KIND_TEMPERATURE = "temperature"
KIND_HUMIDITY = "humidity"
_KINDS = (KIND_TEMPERATURE, KIND_HUMIDITY)
_DEVICE_CLASS_BATTERY = "battery"

# Au-delà de ce délai sans nouvelle mesure, une sonde est considérée
# indisponible (spec 006, clarification Q2). Seule source de cette règle :
# le panneau ne la recalcule pas, et la future régulation la réutilisera.
STALE_AFTER = timedelta(minutes=60)


class RoomNotFoundError(Exception):
    """La pièce (Area) n'existe pas."""


class SensorNotFoundError(Exception):
    """Le capteur de température n'existe pas ou n'en est pas un."""


class HumidityNotFoundError(Exception):
    """Le capteur d'humidité n'existe pas ou n'en est pas un."""


class AlreadyUsedError(Exception):
    """Le capteur est déjà associé à une autre pièce (`room_name`)."""

    def __init__(self, room_name: str) -> None:
        super().__init__(room_name)
        self.room_name = room_name


class SensorAlreadyUsedError(AlreadyUsedError):
    """Le capteur de température est déjà celui d'une autre pièce."""


class HumidityAlreadyUsedError(AlreadyUsedError):
    """Le capteur d'humidité est déjà celui d'une autre pièce."""


SENSOR_ERRORS = (
    RoomNotFoundError,
    SensorNotFoundError,
    HumidityNotFoundError,
    AlreadyUsedError,
)


def sensor_error(err: Exception) -> tuple[str, str]:
    """Code et message d'une erreur d'association (contrat spec 006),
    partagés par `set_room_sensor` et l'appairage (spec 007)."""
    if isinstance(err, RoomNotFoundError):
        return "room_not_found", "Pièce introuvable."
    if isinstance(err, SensorNotFoundError):
        return "sensor_not_found", "Ce capteur de température n'existe pas."
    if isinstance(err, HumidityNotFoundError):
        return "humidity_not_found", "Ce capteur d'humidité n'existe pas."
    if isinstance(err, SensorAlreadyUsedError):
        return "sensor_already_used", f"Cette sonde est déjà associée à {err.room_name}."
    if isinstance(err, HumidityAlreadyUsedError):
        return (
            "humidity_already_used",
            f"Ce capteur d'humidité est déjà associé à {err.room_name}.",
        )
    raise err


def sensor_kind(state: State | None) -> str | None:
    if state is None or state.domain != "sensor":
        return None
    device_class = state.attributes.get("device_class")
    return device_class if device_class in _KINDS else None


def _device_id(hass: HomeAssistant, entity_id: str) -> str | None:
    entry = er.async_get(hass).async_get(entity_id)
    return entry.device_id if entry is not None else None


def _is_battery(hass: HomeAssistant, entry: er.RegistryEntry) -> bool:
    state = hass.states.get(entry.entity_id)
    if state is not None:
        return state.attributes.get("device_class") == _DEVICE_CLASS_BATTERY
    return (entry.device_class or entry.original_device_class) == _DEVICE_CLASS_BATTERY


@callback
def battery_entity_for(hass: HomeAssistant, entity_id: str) -> str | None:
    """Capteur de pile de l'appareil portant `entity_id`, ou `None` (R3)."""
    device_id = _device_id(hass, entity_id)
    if device_id is None:
        return None
    entries = er.async_entries_for_device(er.async_get(hass), device_id)
    candidates = sorted(
        entry.entity_id
        for entry in entries
        if entry.domain == "sensor" and _is_battery(hass, entry)
    )
    return candidates[0] if candidates else None


def is_stale(state: State | None, now: datetime) -> bool:
    """Vrai si la dernière mesure numérique date de plus de `STALE_AFTER`.

    Un état `unavailable` ou `unknown` n'est pas « périmé » : il est
    traité à part (indisponible / en attente, research R6).
    """
    if state is None or state.state in (STATE_UNAVAILABLE, STATE_UNKNOWN):
        return False
    return now - state.last_reported > STALE_AFTER


def _rooms_using(hass: HomeAssistant, kind: str) -> dict[str, ar.AreaEntry]:
    """Index `entity_id → Area` des capteurs d'un `kind` déjà associés."""
    field = "temperature_entity_id" if kind == KIND_TEMPERATURE else "humidity_entity_id"
    return {
        getattr(area, field): area
        for area in ar.async_get(hass).async_list_areas()
        if getattr(area, field) is not None
    }


@callback
def list_sensor_candidates(hass: HomeAssistant) -> list[dict[str, Any]]:
    """Capteurs de température et d'humidité proposables (R2)."""
    entity_registry = er.async_get(hass)
    device_registry = dr.async_get(hass)
    area_registry = ar.async_get(hass)
    used = {kind: _rooms_using(hass, kind) for kind in _KINDS}

    candidates = []
    for state in hass.states.async_all("sensor"):
        kind = sensor_kind(state)
        if kind is None:
            continue
        entry = entity_registry.async_get(state.entity_id)
        device_id = entry.device_id if entry is not None else None
        area_id = entry.area_id if entry is not None else None
        if area_id is None and device_id is not None:
            device = device_registry.async_get(device_id)
            area_id = device.area_id if device is not None else None
        area = area_registry.async_get_area(area_id) if area_id is not None else None
        used_by = used[kind].get(state.entity_id)
        candidates.append(
            {
                "entity_id": state.entity_id,
                "name": state.name,
                "kind": kind,
                "state": state.state,
                "unit": state.attributes.get("unit_of_measurement"),
                "device_id": device_id,
                "area_id": area.id if area is not None else None,
                "area_name": area.name if area is not None else None,
                "used_by_room_id": used_by.id if used_by is not None else None,
                "used_by_room_name": used_by.name if used_by is not None else None,
            }
        )
    return sorted(candidates, key=lambda c: (c["name"].casefold(), c["entity_id"]))


def _check_not_used(
    hass: HomeAssistant, kind: str, entity_id: str, room_id: str, error: type[AlreadyUsedError]
) -> None:
    other = _rooms_using(hass, kind).get(entity_id)
    if other is not None and other.id != room_id:
        raise error(other.name)


@callback
def async_set_room_sensor(
    hass: HomeAssistant,
    room_id: str,
    temperature_entity_id: str,
    humidity_entity_id: str | None = None,
) -> None:
    """Associe une sonde à une pièce (FR-007, FR-008, FR-009).

    Tout est validé avant la moindre écriture : une erreur ne modifie
    rien.
    """
    area_registry = ar.async_get(hass)
    if area_registry.async_get_area(room_id) is None:
        raise RoomNotFoundError(room_id)
    if sensor_kind(hass.states.get(temperature_entity_id)) != KIND_TEMPERATURE:
        raise SensorNotFoundError(temperature_entity_id)
    if (
        humidity_entity_id is not None
        and sensor_kind(hass.states.get(humidity_entity_id)) != KIND_HUMIDITY
    ):
        raise HumidityNotFoundError(humidity_entity_id)
    _check_not_used(hass, KIND_TEMPERATURE, temperature_entity_id, room_id, SensorAlreadyUsedError)
    if humidity_entity_id is not None:
        _check_not_used(hass, KIND_HUMIDITY, humidity_entity_id, room_id, HumidityAlreadyUsedError)

    try:
        area_registry.async_update(
            room_id,
            temperature_entity_id=temperature_entity_id,
            humidity_entity_id=humidity_entity_id,
        )
    except ValueError as err:
        raise SensorNotFoundError(temperature_entity_id) from err

    # Range l'appareil de la sonde dans la pièce (clarification Q3).
    device_id = _device_id(hass, temperature_entity_id)
    if device_id is not None:
        dr.async_get(hass).async_update_device(device_id, area_id=room_id)


@callback
def async_clear_room_sensor(hass: HomeAssistant, room_id: str) -> None:
    """Dissocie la sonde d'une pièce (FR-016). L'appareil reste rangé où il est."""
    area_registry = ar.async_get(hass)
    if area_registry.async_get_area(room_id) is None:
        raise RoomNotFoundError(room_id)
    area_registry.async_update(
        room_id, temperature_entity_id=None, humidity_entity_id=None
    )
