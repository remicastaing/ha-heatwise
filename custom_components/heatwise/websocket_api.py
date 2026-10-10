"""Commandes websocket du panneau Heatwise.

Toutes les commandes sont réservées aux administrateurs (cf.
contracts/websocket-api.md, specs 002 à 006).
"""
from __future__ import annotations

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import area_registry as ar
from homeassistant.util import dt as dt_util

from . import pairing as pairing_module
from . import radiators as radiators_module
from . import rooms as rooms_module
from . import schedule as schedule_module
from . import schedules_store
from . import sensors as sensors_module
from .const import DOMAIN
from .rfplayer_client import RFPlayerClient, RFPlayerUnreachable
from .rooms import InvalidRoomNameError


def _client(hass: HomeAssistant) -> RFPlayerClient | None:
    return hass.data.get(DOMAIN, {}).get("client")


def _room_exists(hass: HomeAssistant, room_id: str) -> bool:
    return ar.async_get(hass).async_get_area(room_id) is not None


@websocket_api.websocket_command({"type": "heatwise/list_rooms"})
@websocket_api.require_admin
@websocket_api.async_response
async def handle_list_rooms(hass, connection, msg):
    connection.send_result(msg["id"], {"rooms": await rooms_module.list_rooms(hass)})


@websocket_api.websocket_command({"type": "heatwise/create_room", "name": str})
@websocket_api.require_admin
@callback
def handle_create_room(hass, connection, msg):
    try:
        room = rooms_module.create_room(hass, msg["name"])
    except InvalidRoomNameError:
        connection.send_error(msg["id"], "invalid_name", "Le nom est obligatoire.")
        return
    connection.send_result(msg["id"], {"room": room})


@websocket_api.websocket_command(
    {"type": "heatwise/pair_radiator", "room_id": str}
)
@websocket_api.require_admin
@websocket_api.async_response
async def handle_pair_radiator(hass, connection, msg):
    if ar.async_get(hass).async_get_area(msg["room_id"]) is None:
        connection.send_error(msg["id"], "room_not_found", "Pièce introuvable.")
        return

    client = _client(hass)
    if client is None:
        connection.send_error(
            msg["id"], "rfplayer_not_configured", "Aucun port RFPlayer configuré."
        )
        return

    try:
        transmitter_id = await radiators_module.async_allocate_transmitter_id(hass)
    except radiators_module.NoTransmitterIdAvailableError:
        connection.send_error(
            msg["id"],
            "no_transmitter_id_available",
            "Plus aucune identité radio disponible.",
        )
        return

    try:
        await client.async_pair(transmitter_id)
    except RFPlayerUnreachable:
        connection.send_error(
            msg["id"], "rfplayer_unreachable", "Le dongle RFPlayer est injoignable."
        )
        return

    connection.send_result(msg["id"], {"transmitter_id": transmitter_id})


@websocket_api.websocket_command(
    {
        "type": "heatwise/confirm_radiator_pairing",
        vol.Required("transmitter_id"): vol.All(int, vol.Range(min=0, max=255)),
        "room_id": str,
        "success": bool,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def handle_confirm_radiator_pairing(hass, connection, msg):
    if not msg["success"]:
        connection.send_result(msg["id"], {"acknowledged": True})
        return

    area = ar.async_get(hass).async_get_area(msg["room_id"])
    if area is None:
        connection.send_error(msg["id"], "room_not_found", "Pièce introuvable.")
        return

    default_name = await radiators_module.compute_default_name(
        hass, area.name or msg["room_id"]
    )
    connection.send_result(msg["id"], {"default_name": default_name})


@websocket_api.websocket_command(
    {
        "type": "heatwise/save_radiator",
        vol.Required("transmitter_id"): vol.All(int, vol.Range(min=0, max=255)),
        "room_id": str,
        "name": str,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def handle_save_radiator(hass, connection, msg):
    try:
        radiator = await radiators_module.async_save_radiator(
            hass, msg["transmitter_id"], msg["room_id"], msg["name"]
        )
    except radiators_module.InvalidRadiatorNameError:
        connection.send_error(msg["id"], "invalid_name", "Le nom est obligatoire.")
        return
    except radiators_module.RadiatorNameAlreadyUsedError:
        connection.send_error(
            msg["id"], "name_already_used", "Ce nom est déjà utilisé par un radiateur."
        )
        return
    except radiators_module.TransmitterIdAlreadyUsedError:
        connection.send_error(
            msg["id"],
            "transmitter_id_already_used",
            "Cette identité radio est déjà attribuée à un radiateur.",
        )
        return

    connection.send_result(msg["id"], {"radiator": radiator})


@websocket_api.websocket_command(
    {
        "type": "heatwise/abandon_radiator_pairing",
        vol.Required("transmitter_id"): vol.All(int, vol.Range(min=0, max=255)),
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def handle_abandon_radiator_pairing(hass, connection, msg):
    client = _client(hass)
    if client is not None:
        try:
            await client.async_unpair(msg["transmitter_id"])
        except RFPlayerUnreachable:
            # Best-effort : ne pas bloquer l'abandon sur l'injoignabilité
            # du dongle (FR-012 — rien n'a de toute façon été persisté).
            pass
    connection.send_result(msg["id"], {"acknowledged": True})


@websocket_api.websocket_command({"type": "heatwise/list_radiators", "room_id": str})
@websocket_api.require_admin
@websocket_api.async_response
async def handle_list_radiators(hass, connection, msg):
    radiators = await radiators_module.async_list_radiators(hass, msg["room_id"])
    connection.send_result(msg["id"], {"radiators": radiators})


@websocket_api.websocket_command(
    {
        "type": "heatwise/delete_radiator",
        "radiator_id": str,
        vol.Optional("force", default=False): bool,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def handle_delete_radiator(hass, connection, msg):
    client = _client(hass)
    try:
        result = await radiators_module.async_delete_radiator(
            hass, client, msg["radiator_id"], force=msg["force"]
        )
    except radiators_module.RadiatorNotFoundError:
        connection.send_error(msg["id"], "radiator_not_found", "Radiateur introuvable.")
        return
    except radiators_module.RFPlayerNotConfiguredError:
        connection.send_error(
            msg["id"], "rfplayer_not_configured", "Aucun port RFPlayer configuré."
        )
        return
    except RFPlayerUnreachable:
        connection.send_error(
            msg["id"], "rfplayer_unreachable", "Le dongle RFPlayer est injoignable."
        )
        return

    connection.send_result(msg["id"], result)


@websocket_api.websocket_command(
    {
        "type": "heatwise/set_radiator_heating",
        "radiator_id": str,
        "heating": bool,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def handle_set_radiator_heating(hass, connection, msg):
    client = _client(hass)
    try:
        radiator = await radiators_module.async_set_heating(
            hass, client, msg["radiator_id"], heating=msg["heating"]
        )
    except radiators_module.RadiatorNotFoundError:
        connection.send_error(msg["id"], "radiator_not_found", "Radiateur introuvable.")
        return
    except radiators_module.RFPlayerNotConfiguredError:
        connection.send_error(
            msg["id"], "rfplayer_not_configured", "Aucun port RFPlayer configuré."
        )
        return
    except RFPlayerUnreachable:
        connection.send_error(
            msg["id"], "rfplayer_unreachable", "Le dongle RFPlayer est injoignable."
        )
        return

    connection.send_result(msg["id"], {"radiator": radiator})


# --- Programmation (spec 005) ---


@websocket_api.websocket_command({"type": "heatwise/get_schedule", "room_id": str})
@websocket_api.require_admin
@websocket_api.async_response
async def handle_get_schedule(hass, connection, msg):
    if not _room_exists(hass, msg["room_id"]):
        connection.send_error(msg["id"], "room_not_found", "Pièce introuvable.")
        return

    room_schedule = await schedules_store.async_get_room_schedule(hass, msg["room_id"])
    settings = await schedules_store.async_get_settings(hass)
    now = dt_util.now()
    program, week_number = schedule_module.active_program(
        room_schedule, settings["vacation_mode"], now
    )
    connection.send_result(
        msg["id"],
        {
            "schedule": room_schedule,
            "settings": settings,
            "active": {
                "program": program,
                "weekday": now.weekday(),
                "minute": now.hour * 60 + now.minute,
                "week_number": week_number,
            },
        },
    )


@websocket_api.websocket_command(
    {
        "type": "heatwise/edit_schedule",
        "room_id": str,
        vol.Required("program"): vol.In(schedule_module.PROGRAMS),
        vol.Required("operations"): vol.All(
            [
                {
                    vol.Required("day"): int,
                    vol.Required("start"): int,
                    vol.Required("end"): int,
                    vol.Required("temperature"): vol.Any(None, vol.Coerce(float)),
                }
            ],
            vol.Length(min=1),
        ),
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def handle_edit_schedule(hass, connection, msg):
    if not _room_exists(hass, msg["room_id"]):
        connection.send_error(msg["id"], "room_not_found", "Pièce introuvable.")
        return

    def _apply(current: dict) -> dict:
        current[msg["room_id"]] = schedule_module.apply_operations(
            current[msg["room_id"]], msg["program"], msg["operations"]
        )
        return current

    try:
        result = await schedules_store.async_mutate_rooms(hass, [msg["room_id"]], _apply)
    except schedule_module.ProgramNotFoundError:
        connection.send_error(
            msg["id"], "program_not_found", "Programme non disponible pour cette pièce."
        )
        return
    except schedule_module.InvalidSlotError as err:
        connection.send_error(msg["id"], "invalid_slot", str(err))
        return
    except schedule_module.InvalidTemperatureError as err:
        connection.send_error(msg["id"], "invalid_temperature", str(err))
        return

    connection.send_result(msg["id"], {"schedule": result[msg["room_id"]]})


@websocket_api.websocket_command(
    {
        "type": "heatwise/copy_days",
        "room_id": str,
        vol.Required("program"): vol.In(schedule_module.PROGRAMS),
        vol.Required("source_day"): int,
        vol.Required("target_days"): vol.All([int], vol.Length(min=1)),
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def handle_copy_days(hass, connection, msg):
    if not _room_exists(hass, msg["room_id"]):
        connection.send_error(msg["id"], "room_not_found", "Pièce introuvable.")
        return

    def _copy(current: dict) -> dict:
        current[msg["room_id"]] = schedule_module.copy_days(
            current[msg["room_id"]], msg["program"], msg["source_day"], msg["target_days"]
        )
        return current

    try:
        result = await schedules_store.async_mutate_rooms(hass, [msg["room_id"]], _copy)
    except schedule_module.ProgramNotFoundError:
        connection.send_error(
            msg["id"], "program_not_found", "Programme non disponible pour cette pièce."
        )
        return
    except schedule_module.InvalidSlotError as err:
        connection.send_error(msg["id"], "invalid_slot", str(err))
        return

    connection.send_result(msg["id"], {"schedule": result[msg["room_id"]]})


@websocket_api.websocket_command(
    {
        "type": "heatwise/copy_program",
        "room_id": str,
        vol.Required("source"): vol.In(schedule_module.PROGRAMS),
        vol.Required("target"): vol.In(schedule_module.PROGRAMS),
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def handle_copy_program(hass, connection, msg):
    if not _room_exists(hass, msg["room_id"]):
        connection.send_error(msg["id"], "room_not_found", "Pièce introuvable.")
        return

    def _copy(current: dict) -> dict:
        current[msg["room_id"]] = schedule_module.copy_program(
            current[msg["room_id"]], msg["source"], msg["target"]
        )
        return current

    try:
        result = await schedules_store.async_mutate_rooms(hass, [msg["room_id"]], _copy)
    except schedule_module.InvalidCopyError as err:
        connection.send_error(msg["id"], "invalid_copy", str(err))
        return
    except schedule_module.ProgramNotFoundError:
        connection.send_error(
            msg["id"], "program_not_found", "Programme non disponible pour cette pièce."
        )
        return

    connection.send_result(msg["id"], {"schedule": result[msg["room_id"]]})


@websocket_api.websocket_command(
    {
        "type": "heatwise/set_parity",
        "room_id": str,
        vol.Required("enabled"): bool,
        vol.Optional("keep"): vol.In(["even", "odd"]),
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def handle_set_parity(hass, connection, msg):
    if not _room_exists(hass, msg["room_id"]):
        connection.send_error(msg["id"], "room_not_found", "Pièce introuvable.")
        return

    def _set(current: dict) -> dict:
        current[msg["room_id"]] = schedule_module.set_parity(
            current[msg["room_id"]], msg["enabled"], msg.get("keep")
        )
        return current

    try:
        result = await schedules_store.async_mutate_rooms(hass, [msg["room_id"]], _set)
    except schedule_module.KeepRequiredError:
        connection.send_error(
            msg["id"],
            "keep_required",
            "Indiquez laquelle des deux semaines conserver (« keep »).",
        )
        return

    connection.send_result(msg["id"], {"schedule": result[msg["room_id"]]})


@websocket_api.websocket_command(
    {
        "type": "heatwise/copy_room_schedule",
        "room_id": str,
        vol.Required("target_room_ids"): vol.All([str], vol.Length(min=1)),
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def handle_copy_room_schedule(hass, connection, msg):
    room_id = msg["room_id"]
    target_room_ids = [
        target_id for target_id in msg["target_room_ids"] if target_id != room_id
    ]

    if not _room_exists(hass, room_id):
        connection.send_error(msg["id"], "room_not_found", "Pièce introuvable.")
        return
    for target_id in target_room_ids:
        if not _room_exists(hass, target_id):
            connection.send_error(msg["id"], "room_not_found", "Pièce cible introuvable.")
            return

    if not target_room_ids:
        connection.send_result(msg["id"], {"copied": 0})
        return

    source_schedule = await schedules_store.async_get_room_schedule(hass, room_id)

    def _copy(current: dict) -> dict:
        for target_id in target_room_ids:
            current[target_id] = schedule_module.copy_room_schedule(source_schedule)
        return current

    await schedules_store.async_mutate_rooms(hass, target_room_ids, _copy)
    connection.send_result(msg["id"], {"copied": len(target_room_ids)})


@websocket_api.websocket_command({"type": "heatwise/get_settings"})
@websocket_api.require_admin
@websocket_api.async_response
async def handle_get_settings(hass, connection, msg):
    connection.send_result(msg["id"], {"settings": await schedules_store.async_get_settings(hass)})


@websocket_api.websocket_command(
    {
        "type": "heatwise/update_settings",
        vol.Optional("default_temperature"): vol.Coerce(float),
        vol.Optional("vacation_mode"): bool,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def handle_update_settings(hass, connection, msg):
    # Les deux champs sont optionnels au schéma : un payload sans aucun
    # d'eux le validerait quand même, il faut donc ce contrôle explicite
    # (FR-011/FR-022 : au moins un champ à modifier).
    changes = {
        key: msg[key] for key in ("default_temperature", "vacation_mode") if key in msg
    }
    if not changes:
        connection.send_error(
            msg["id"], "invalid_format", "Au moins un champ à modifier est requis."
        )
        return

    try:
        settings = await schedules_store.async_update_settings(hass, **changes)
    except schedule_module.InvalidTemperatureError as err:
        connection.send_error(msg["id"], "invalid_temperature", str(err))
        return

    connection.send_result(msg["id"], {"settings": settings})


# --- Sondes (spec 006) ---


@websocket_api.websocket_command({"type": "heatwise/list_sensors"})
@websocket_api.require_admin
@callback
def handle_list_sensors(hass, connection, msg):
    connection.send_result(
        msg["id"],
        {
            "sensors": sensors_module.list_sensor_candidates(hass),
            # Spec 007 : le bouton « Appairer une nouvelle sonde » n'est
            # proposé que si ZHA est chargé.
            "pairing_available": pairing_module.pairing_available(hass),
        },
    )


@websocket_api.websocket_command(
    {
        "type": "heatwise/set_room_sensor",
        "room_id": str,
        "temperature_entity_id": str,
        vol.Optional("humidity_entity_id", default=None): vol.Any(str, None),
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def handle_set_room_sensor(hass, connection, msg):
    try:
        sensors_module.async_set_room_sensor(
            hass, msg["room_id"], msg["temperature_entity_id"], msg["humidity_entity_id"]
        )
    except sensors_module.SENSOR_ERRORS as err:
        connection.send_error(msg["id"], *sensors_module.sensor_error(err))
        return

    connection.send_result(
        msg["id"], {"room": await rooms_module.async_get_room(hass, msg["room_id"])}
    )


@websocket_api.websocket_command(
    {"type": "heatwise/clear_room_sensor", "room_id": str}
)
@websocket_api.require_admin
@websocket_api.async_response
async def handle_clear_room_sensor(hass, connection, msg):
    try:
        sensors_module.async_clear_room_sensor(hass, msg["room_id"])
    except sensors_module.RoomNotFoundError:
        connection.send_error(msg["id"], "room_not_found", "Pièce introuvable.")
        return

    connection.send_result(
        msg["id"], {"room": await rooms_module.async_get_room(hass, msg["room_id"])}
    )


# --- Appairage d'une sonde Zigbee (spec 007) ---


@websocket_api.websocket_command({"type": "heatwise/pair_sensor", "room_id": str})
@websocket_api.require_admin
@websocket_api.async_response
async def handle_pair_sensor(hass, connection, msg):
    """Abonnement : ouvre l'appairage Zigbee et relaie les événements de
    la session (contrat spec 007). Le désabonnement — ou la fermeture de
    la connexion — arrête la session et referme le réseau."""
    if not _room_exists(hass, msg["room_id"]):
        connection.send_error(msg["id"], "room_not_found", "Pièce introuvable.")
        return

    session = pairing_module.SensorPairingSession(
        hass,
        msg["room_id"],
        lambda event: connection.send_message(
            websocket_api.event_message(msg["id"], event)
        ),
        connection.context(msg),
    )

    @callback
    def _unsubscribe() -> None:
        hass.async_create_task(session.async_stop())

    connection.subscriptions[msg["id"]] = _unsubscribe
    try:
        await session.async_start()
    except pairing_module.PairingUnavailableError as err:
        connection.subscriptions.pop(msg["id"], None)
        connection.send_error(
            msg["id"],
            "pairing_unavailable",
            f"Impossible d'ouvrir l'appairage Zigbee : {err}",
        )
        return
    connection.send_result(msg["id"])
    session.emit_waiting()


def async_register_commands(hass: HomeAssistant) -> None:
    """Enregistre les commandes websocket du panneau Heatwise."""
    websocket_api.async_register_command(hass, handle_list_rooms)
    websocket_api.async_register_command(hass, handle_create_room)
    websocket_api.async_register_command(hass, handle_pair_radiator)
    websocket_api.async_register_command(hass, handle_confirm_radiator_pairing)
    websocket_api.async_register_command(hass, handle_save_radiator)
    websocket_api.async_register_command(hass, handle_abandon_radiator_pairing)
    websocket_api.async_register_command(hass, handle_list_radiators)
    websocket_api.async_register_command(hass, handle_set_radiator_heating)
    websocket_api.async_register_command(hass, handle_delete_radiator)
    websocket_api.async_register_command(hass, handle_get_schedule)
    websocket_api.async_register_command(hass, handle_edit_schedule)
    websocket_api.async_register_command(hass, handle_copy_days)
    websocket_api.async_register_command(hass, handle_copy_program)
    websocket_api.async_register_command(hass, handle_set_parity)
    websocket_api.async_register_command(hass, handle_copy_room_schedule)
    websocket_api.async_register_command(hass, handle_get_settings)
    websocket_api.async_register_command(hass, handle_update_settings)
    websocket_api.async_register_command(hass, handle_list_sensors)
    websocket_api.async_register_command(hass, handle_set_room_sensor)
    websocket_api.async_register_command(hass, handle_pair_sensor)
    websocket_api.async_register_command(hass, handle_clear_room_sensor)
