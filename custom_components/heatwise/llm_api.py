"""API LLM Heatwise (spec 012).

Heatwise déclare auprès de Home Assistant une API d'outils pour
assistants IA. Le serveur MCP natif de Home Assistant (`mcp_server`) la
publie aux clients MCP (Claude Code, Claude Desktop) ; un agent Assist
peut aussi la sélectionner. Heatwise n'ouvre aucun point d'accès propre
(research R1, FR-004).

Les outils appellent directement les modules métier ; les erreurs sont
renvoyées comme résultats `{"error", "message"}` (research R7, FR-020).
Tous les outils sont réservés aux administrateurs, comme le panneau
(research R3, FR-015).
"""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import llm
from homeassistant.loader import async_get_integration
from homeassistant.util import dt as dt_util
from homeassistant.util.json import JsonObjectType

from . import llm_format
from . import radiators as radiators_module
from . import rooms as rooms_module
from . import schedule as schedule_module
from . import schedules_store
from .const import (
    DOMAIN,
    HISTORY_PERIODS,
    LLM_API_ID,
    LLM_API_NAME,
    LLM_SERIES_MAX_POINTS,
    LLM_TARGET_CHANGES_MAX,
)
from .history_recorder import HistoryUnavailableError, get_history_recorder
from .llm_format import ToolError
from .regulator import (
    TEMPORARY_TARGET_ERRORS,
    RoomWithoutRadiatorError,
    get_regulator,
    parse_temporary_end,
    temporary_target_error,
)
from .rfplayer_client import RFPlayerUnreachable

_LOGGER = logging.getLogger(__name__)

API_PROMPT = (
    "You control Heatwise, the heating system of this home (X2D electric "
    "radiators, one Zigbee temperature sensor per room). Temperatures are in "
    f"°C, between {schedule_module.MIN_TEMPERATURE:g} and "
    f"{schedule_module.MAX_TEMPERATURE:g}, in steps of "
    f"{schedule_module.TEMPERATURE_STEP:g}. Times are local: \"HH:MM\" for "
    "inputs and schedules, \"YYYY-MM-DDTHH:MM\" for deadlines. "
    "A room's target comes from its weekly schedule, unless a temporary "
    "target is set or vacation mode is on. \"Heat 1 h\" forces a room's "
    "radiators on for one hour and pauses regulation; it stops by itself. "
    "Rooms can be named by id or by name. You cannot create, rename or "
    "delete rooms, pair devices or control a single radiator. Before any "
    "action, state what you are about to change. Answer the user in their "
    "language."
)

ROOM_PARAM = vol.Required(
    "room", description="Room id or room name (case and accents ignored)."
)


class HeatwiseTool(llm.Tool):
    """Outil Heatwise : contrôle d'accès, validation des paramètres,
    résolution de la pièce, conversion des erreurs, journalisation."""

    # Outil qui modifie quelque chose (journalisé en INFO, R14).
    action: bool = False
    # Paramètre `room` à résoudre en pièce Heatwise (R6).
    needs_room: bool = False

    async def async_call(
        self, hass: HomeAssistant, tool_input: llm.ToolInput, llm_context: llm.LLMContext
    ) -> JsonObjectType:
        room_name: str | None = None
        try:
            await _async_require_admin(hass, llm_context)
            try:
                args = self.parameters(tool_input.tool_args or {})
            except vol.Invalid as err:
                raise ToolError("invalid_arguments", f"Paramètres invalides : {err}") from err
            room: dict[str, Any] | None = None
            if self.needs_room:
                room = llm_format.resolve_room(
                    await rooms_module.list_rooms(hass), args["room"]
                )
                room_name = room["name"]
            result = await self.async_run(hass, args, room)
        except ToolError as err:
            self._log(llm_context, room_name or tool_input.tool_args.get("room"), err.code)
            return err.as_dict()
        self._log(llm_context, room_name, "ok")
        return result

    async def async_run(
        self, hass: HomeAssistant, args: dict[str, Any], room: dict[str, Any] | None
    ) -> JsonObjectType:
        raise NotImplementedError

    def _log(self, llm_context: llm.LLMContext, room: Any, outcome: str) -> None:
        _LOGGER.log(
            logging.INFO if self.action else logging.DEBUG,
            "Assistant IA (%s) : %s pièce=%s → %s",
            llm_context.platform,
            self.name,
            room,
            outcome,
        )


async def _async_require_admin(hass: HomeAssistant, llm_context: llm.LLMContext) -> None:
    context = llm_context.context
    user_id = context.user_id if context is not None else None
    user = await hass.auth.async_get_user(user_id) if user_id else None
    if user is None or not user.is_admin:
        raise ToolError(
            "unauthorized", "Heatwise est réservé aux administrateurs de Home Assistant."
        )


def _state(hass: HomeAssistant, entity_id: str | None) -> str | None:
    state = hass.states.get(entity_id) if entity_id else None
    return state.state if state is not None else None


# --- Lecture (US1) ---


class ListRoomsTool(HeatwiseTool):
    name = "list_rooms"
    description = (
        "List all Heatwise rooms with measured temperature and humidity, "
        "current target, whether they are heating, and regulation status."
    )

    async def async_run(self, hass, args, room):
        rooms = await rooms_module.list_rooms(hass)
        settings = await schedules_store.async_get_settings(hass)
        return {
            "rooms": [
                llm_format.room_summary(r, humidity=_state(hass, r["humidity_entity_id"]))
                for r in rooms
            ],
            "vacation_mode": settings["vacation_mode"],
        }


class GetRoomTool(HeatwiseTool):
    name = "get_room"
    description = (
        "Detailed state of one room: measures, sensor health, target and "
        "regulation status with its reason, manual heating end, active "
        "schedule program and radiators."
    )
    parameters = vol.Schema({ROOM_PARAM: str})
    needs_room = True

    async def async_run(self, hass, args, room):
        radiators = await radiators_module.async_list_radiators(hass, room["room_id"])
        detail = llm_format.room_detail(
            room,
            humidity=_state(hass, room["humidity_entity_id"]),
            battery=_state(hass, room["battery_entity_id"]),
            radiators=radiators,
            tz=dt_util.get_default_time_zone(),
        )
        room_schedule = await schedules_store.async_get_room_schedule(hass, room["room_id"])
        settings = await schedules_store.async_get_settings(hass)
        detail["program"], _ = schedule_module.active_program(
            room_schedule, settings["vacation_mode"], dt_util.now()
        )
        return detail


class GetSettingsTool(HeatwiseTool):
    name = "get_settings"
    description = (
        "General Heatwise settings: vacation mode, default target outside "
        "scheduled slots, history interval, temperature bounds and version."
    )

    async def async_run(self, hass, args, room):
        settings = await schedules_store.async_get_settings(hass)
        integration = await async_get_integration(hass, DOMAIN)
        return {
            "vacation_mode": settings["vacation_mode"],
            "default_target_c": settings["default_temperature"],
            "history_interval_min": settings["history_interval"],
            "version": str(integration.version) if integration.version else None,
            "temperature_bounds": {
                "min": schedule_module.MIN_TEMPERATURE,
                "max": schedule_module.MAX_TEMPERATURE,
                "step": schedule_module.TEMPERATURE_STEP,
            },
        }


# --- Action (US2 à US5) ---


def _regulator_or_raise(hass: HomeAssistant):
    regulator = get_regulator(hass)
    if regulator is None or regulator.client is None:
        raise ToolError("rfplayer_not_configured", "Aucun dongle RFPlayer n'est configuré.")
    return regulator


class SetRoomHeatingTool(HeatwiseTool):
    name = "set_room_heating"
    description = (
        "Start (heating=true) or stop (heating=false) the 1-hour heating of a "
        "room, exactly like the \"Heat 1 h\" button of the Heatwise panel: all "
        "radiators of the room heat for one hour and regulation is paused; it "
        "stops by itself after one hour."
    )
    parameters = vol.Schema(
        {
            ROOM_PARAM: str,
            vol.Required("heating", description="true to heat 1 h, false to stop."): bool,
        }
    )
    action = True
    needs_room = True

    async def async_run(self, hass, args, room):
        room_id = room["room_id"]
        try:
            regulator = _regulator_or_raise(hass)
            if args["heating"]:
                failed = await regulator.async_room_manual_heating(room_id)
            else:
                failed = await regulator.async_end_room_manual_heating(room_id)
        except RoomWithoutRadiatorError as err:
            raise ToolError("room_without_radiator", "Cette pièce n'a aucun radiateur.") from err
        except radiators_module.RFPlayerNotConfiguredError as err:
            raise ToolError(
                "rfplayer_not_configured", "Aucun dongle RFPlayer n'est configuré."
            ) from err
        except RFPlayerUnreachable as err:
            raise ToolError(
                "rfplayer_unreachable", "Le dongle RFPlayer est injoignable : rien n'a été envoyé."
            ) from err

        names = {
            r["radiator_id"]: r["name"]
            for r in await radiators_module.async_list_radiators(hass, room_id)
        }
        status = regulator.room_status(room_id)
        return {
            "room": room["name"],
            "heating": args["heating"],
            "until": (
                llm_format.local_minute(
                    status["suspended_until"], dt_util.get_default_time_zone()
                )
                if args["heating"]
                else None
            ),
            "failed_radiators": [names.get(rid, rid) for rid in failed],
        }


def _local(value) -> str | None:
    return llm_format.local_minute(value, dt_util.get_default_time_zone())


class SetTemporaryTargetTool(HeatwiseTool):
    name = "set_temporary_target"
    description = (
        "Set a temporary target temperature for a room that has a sensor, "
        "for duration_minutes (30 to 1440) or until a local time \"HH:MM\" "
        "(next occurrence, within 24 h). Exactly one of the two. The room "
        "goes back to its schedule by itself at the deadline. Replaces an "
        "existing temporary target. Refused while vacation mode is on."
    )
    parameters = vol.Schema(
        {
            ROOM_PARAM: str,
            vol.Required("target_c", description="Target in °C, 7 to 25, step 0.5."): vol.Coerce(
                float
            ),
            vol.Optional("duration_minutes", description="Duration, 30 to 1440."): int,
            vol.Optional("until", description="Local end time \"HH:MM\"."): str,
        }
    )
    action = True
    needs_room = True

    async def async_run(self, hass, args, room):
        room_id = room["room_id"]
        try:
            regulator = get_regulator(hass)
            if regulator is None:
                raise radiators_module.RFPlayerNotConfiguredError()
            duration, until = parse_temporary_end(args.get("duration_minutes"), args.get("until"))
            target, replaced = await regulator.async_set_temporary_target(
                room_id, args["target_c"], duration=duration, until=until, origin="assistant"
            )
        except TEMPORARY_TARGET_ERRORS as err:
            raise ToolError(*temporary_target_error(err)) from err
        status = regulator.room_status(room_id)
        return {
            "room": room["name"],
            "target_c": target.temperature,
            "until": _local(target.until),
            "replaced": replaced,
            # Chauffe 1 h en cours : la consigne ne s'applique qu'ensuite (R12).
            "effective_from": _local(status["suspended_until"]),
        }


class ClearTemporaryTargetTool(HeatwiseTool):
    name = "clear_temporary_target"
    description = (
        "Cancel the temporary target of a room: it goes back to its schedule "
        "immediately. Not an error if there was none."
    )
    parameters = vol.Schema({ROOM_PARAM: str})
    action = True
    needs_room = True

    async def async_run(self, hass, args, room):
        regulator = get_regulator(hass)
        cleared = (
            await regulator.async_clear_temporary_target(room["room_id"])
            if regulator is not None
            else False
        )
        current = await rooms_module.async_get_room(hass, room["room_id"])
        return {
            "room": room["name"],
            "cleared": cleared,
            "target_c": current["target_temperature"],
            "target_source": (current["regulation"] or {}).get("target_source"),
        }


PROGRAM_PARAM = vol.Optional(
    "program",
    description=(
        "Schedule program: all (no week parity), even / odd (week parity), "
        "vacation. Default: the active program."
    ),
)


def _week_or_raise(room_schedule: dict[str, Any], program: str) -> list[list[dict[str, Any]]]:
    try:
        return schedule_module.get_week(room_schedule, program)
    except schedule_module.ProgramNotFoundError as err:
        raise ToolError(
            "program_not_found", f"Le programme « {program} » n'existe pas pour cette pièce."
        ) from err


class EditScheduleTool(HeatwiseTool):
    name = "edit_schedule"
    description = (
        "Durably change a room's weekly schedule: set target_c (or remove=true "
        "to remove the target) from start to end (\"HH:MM\", quarter hours, end "
        "up to 24:00) on the given days, in a program (default: the active "
        "one; required while vacation mode is on). All or nothing. Returns "
        "each day before and after."
    )
    parameters = vol.Schema(
        {
            ROOM_PARAM: str,
            vol.Required(
                "days", description="Days: 0-6 (0 = Monday) or names (monday, lundi…)."
            ): [vol.Any(int, str)],
            vol.Required("start", description="Start, local \"HH:MM\"."): str,
            vol.Required("end", description="End, local \"HH:MM\" (24:00 allowed)."): str,
            # Pas de paramètre nullable : le serveur MCP de Home Assistant
            # refuse `null` (schéma OpenAPI 3.0 validé en JSON Schema, T041).
            vol.Optional(
                "target_c", description="Target in °C (7 to 25, step 0.5)."
            ): vol.Coerce(float),
            vol.Optional(
                "remove",
                description="true to remove the target on the range (instead of target_c).",
            ): bool,
            PROGRAM_PARAM: vol.In(schedule_module.PROGRAMS),
        }
    )
    action = True
    needs_room = True

    async def async_run(self, hass, args, room):
        room_id = room["room_id"]
        remove = args.get("remove", False)
        if remove == ("target_c" in args):
            raise ToolError(
                "invalid_arguments", "Indiquer soit target_c, soit remove=true (pas les deux)."
            )
        target = None if remove else args["target_c"]
        days = llm_format.parse_days(args["days"])
        try:
            start = llm_format.hhmm_to_minutes(args["start"])
            end = llm_format.hhmm_to_minutes(args["end"])
        except ValueError as err:
            raise ToolError("invalid_slot", str(err)) from err
        settings = await schedules_store.async_get_settings(hass)
        program = args.get("program")
        if program is None:
            if settings["vacation_mode"]:
                raise ToolError(
                    "program_required",
                    "Le mode vacances est actif : préciser le programme à modifier "
                    "(vacation, ou all / even / odd).",
                )
            room_schedule = await schedules_store.async_get_room_schedule(hass, room_id)
            program, _ = schedule_module.active_program(room_schedule, False, dt_util.now())
        operations = [
            {"day": day, "start": start, "end": end, "temperature": target}
            for day in days
        ]
        before: dict[int, list[str]] = {}

        def _apply(current: dict) -> dict:
            week = _week_or_raise(current[room_id], program)
            before.update({day: llm_format.format_day(week[day]) for day in days})
            current[room_id] = schedule_module.apply_operations(
                current[room_id], program, operations
            )
            return current

        try:
            result = await schedules_store.async_mutate_rooms(hass, [room_id], _apply)
        except schedule_module.InvalidSlotError as err:
            raise ToolError("invalid_slot", str(err)) from err
        except schedule_module.InvalidTemperatureError as err:
            raise ToolError("invalid_temperature", str(err)) from err
        week = schedule_module.get_week(result[room_id], program)
        return {
            "room": room["name"],
            "program": program,
            "changes": [
                {
                    "day": llm_format.DAY_NAMES[day],
                    "before": before[day],
                    "after": llm_format.format_day(week[day]),
                }
                for day in days
            ],
        }


class SetVacationModeTool(HeatwiseTool):
    name = "set_vacation_mode"
    description = (
        "Turn vacation mode on or off for the whole home. While on, every "
        "room follows its vacation program; turning it on cancels all "
        "temporary targets."
    )
    parameters = vol.Schema(
        {vol.Required("enabled", description="true to turn vacation mode on."): bool}
    )
    action = True

    async def async_run(self, hass, args, room):
        enabled = args["enabled"]
        settings = await schedules_store.async_get_settings(hass)
        if settings["vacation_mode"] == enabled:
            return {"vacation_mode": enabled, "changed": False, "cleared_temporary_targets": []}
        regulator = get_regulator(hass)
        with_target = regulator.temporary_target_rooms() if regulator is not None else []
        await schedules_store.async_update_settings(hass, vacation_mode=enabled)
        cleared: list[str] = []
        if regulator is not None:
            # Annulation des consignes temporaires avant de répondre (FR-013a).
            await regulator.async_evaluate()
            still = set(regulator.temporary_target_rooms())
            names = {r["room_id"]: r["name"] for r in await rooms_module.list_rooms(hass)}
            cleared = [names.get(rid, rid) for rid in with_target if rid not in still]
        return {"vacation_mode": enabled, "changed": True, "cleared_temporary_targets": cleared}


class GetScheduleTool(HeatwiseTool):
    name = "get_schedule"
    description = (
        "Weekly schedule of a room: active program, week parity, and for "
        "each day the slots \"HH:MM–HH:MM target\"; outside slots the "
        "default target applies."
    )
    parameters = vol.Schema({ROOM_PARAM: str, PROGRAM_PARAM: vol.In(schedule_module.PROGRAMS)})
    needs_room = True

    async def async_run(self, hass, args, room):
        room_schedule = await schedules_store.async_get_room_schedule(hass, room["room_id"])
        settings = await schedules_store.async_get_settings(hass)
        active, _ = schedule_module.active_program(
            room_schedule, settings["vacation_mode"], dt_util.now()
        )
        shown = args.get("program") or active
        week = _week_or_raise(room_schedule, shown)
        return {
            "room": room["name"],
            "active_program": active,
            "parity": room_schedule["parity"],
            "shown_program": shown,
            "default_target_c": settings["default_temperature"],
            "days": [
                {"day": llm_format.DAY_NAMES[index], "slots": llm_format.format_day(day)}
                for index, day in enumerate(week)
            ],
        }


class GetHistoryTool(HeatwiseTool):
    name = "get_history"
    description = (
        "Summarized history of a room over 24h, 7d or 30d: temperature and "
        "humidity series (at most 100 points), statistics, heating minutes "
        "and target changes."
    )
    parameters = vol.Schema(
        {
            ROOM_PARAM: str,
            vol.Optional("period", default="24h", description="24h, 7d or 30d."): vol.In(
                list(HISTORY_PERIODS)
            ),
        }
    )
    needs_room = True

    async def async_run(self, hass, args, room):
        area = ar.async_get(hass).async_get_area(room["room_id"])
        recorder = get_history_recorder(hass)
        unavailable = ToolError("history_unavailable", "L'historique est indisponible.")
        if recorder is None or area is None:
            raise unavailable
        try:
            raw = await recorder.async_get_room_history(area, args["period"])
        except HistoryUnavailableError as err:
            raise unavailable from err
        return {
            "room": room["name"],
            "period": args["period"],
            **llm_format.summarize_history(
                raw,
                tz=dt_util.get_default_time_zone(),
                max_points=LLM_SERIES_MAX_POINTS,
                max_changes=LLM_TARGET_CHANGES_MAX,
            ),
        }


TOOLS: tuple[type[HeatwiseTool], ...] = (
    ListRoomsTool,
    GetRoomTool,
    GetSettingsTool,
    GetScheduleTool,
    GetHistoryTool,
    SetRoomHeatingTool,
    SetTemporaryTargetTool,
    ClearTemporaryTargetTool,
    EditScheduleTool,
    SetVacationModeTool,
)


class HeatwiseAPI(llm.API):
    """API « Heatwise » (FR-001, FR-003)."""

    async def async_get_api_instance(self, llm_context: llm.LLMContext) -> llm.APIInstance:
        return llm.APIInstance(
            api=self,
            api_prompt=API_PROMPT,
            llm_context=llm_context,
            tools=[tool() for tool in TOOLS],
        )


def async_register(hass: HomeAssistant):
    """Enregistre l'API ; renvoie la fonction de retrait (FR-002)."""
    return llm.async_register_api(
        hass, HeatwiseAPI(hass=hass, id=LLM_API_ID, name=LLM_API_NAME)
    )
