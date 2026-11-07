"""Contrôleur de la régulation automatique (spec 008).

Le `Regulator` relie Home Assistant à la décision pure de
`regulation.py` : il collecte les entrées de chaque pièce (consigne de
la programmation, mesure de la sonde), applique la décision à tous les
radiateurs de la pièce via `radiators.async_apply_regulation`, renvoie
l'ordre courant de chaque radiateur toutes les 5 min (spec 011 : pièces
régulées, suspendues, sans sonde et radiateurs sans pièce), suspend une
pièce 1 h après une action manuelle, exécute l'échéance des chauffes
manuelles sous son verrou, et expose l'état de chaque pièce au panneau.

Il ne connaît pas l'algorithme : changer de politique ne touche que
`regulation.py` (cf. contracts/regulation-policy.md). Une seule
instance, dans `hass.data[DOMAIN]["regulator"]`, créée par
`__init__.py` après l'arrêt de tous les radiateurs au démarrage.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timedelta
import logging
from typing import Any

from homeassistant.const import STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.event import (
    async_track_state_change_event,
    async_track_time_interval,
)
from homeassistant.util import dt as dt_util

from . import llm_format
from . import radiators as radiators_module
from . import regulation
from . import schedule as schedule_module
from . import schedules_store
from . import sensors as sensors_module
from .const import (
    DOMAIN,
    EVENT_REGULATION_UPDATED,
    EVENT_SCHEDULE_UPDATED,
    MANUAL_SUSPENSION,
    REGULATION_RESEND,
    REGULATION_TICK,
    SIGNAL_RADIATORS_CHANGED,
    TEMPORARY_TARGET_MAX,
    TEMPORARY_TARGET_MIN,
)
from .regulation import Decision, Reason, RegulationPolicy, RoomInputs, SensorHealth
from .rfplayer_client import RFPlayerClient, RFPlayerUnreachable

_LOGGER = logging.getLogger(__name__)

# Statuts exposés au panneau (contracts/websocket-api.md).
STATUS_HEATING = "heating"
STATUS_IDLE = "idle"
STATUS_SAFETY_STOP = "safety_stop"
STATUS_SUSPENDED = "suspended"
STATUS_NOT_REGULATED = "not_regulated"

REASON_DONGLE_UNREACHABLE = "dongle_unreachable"
REASON_MANUAL = "manual"
REASON_RFPLAYER_NOT_CONFIGURED = "rfplayer_not_configured"

_SAFETY_REASONS = {Reason.SENSOR_UNAVAILABLE, Reason.SENSOR_STALE}



class RoomWithoutRadiatorError(Exception):
    """Chauffe 1 h demandée pour une pièce sans radiateur (spec 011)."""


class RoomNotRegulatedError(Exception):
    """Consigne temporaire refusée : la pièce n'a pas de sonde (spec 012)."""


class VacationModeActiveError(Exception):
    """Consigne temporaire refusée : le mode vacances est actif (spec 012)."""


class InvalidDurationError(ValueError):
    """Durée ou échéance de consigne temporaire hors bornes (spec 012)."""


def temporary_target_error(err: Exception) -> tuple[str, str] | None:
    """Code et message d'un refus de consigne temporaire, communs au
    panneau et aux outils LLM (contracts/websocket-api.md, llm-tools.md)."""
    if isinstance(err, RoomWithoutRadiatorError):
        return "room_without_radiator", "Cette pièce n'a aucun radiateur."
    if isinstance(err, radiators_module.RFPlayerNotConfiguredError):
        return "rfplayer_not_configured", "Aucun dongle RFPlayer n'est configuré."
    if isinstance(err, RoomNotRegulatedError):
        return (
            "room_not_regulated",
            "Cette pièce n'a pas de sonde : elle ne peut pas suivre une température.",
        )
    if isinstance(err, VacationModeActiveError):
        return (
            "vacation_mode_active",
            "Le mode vacances est actif : désactivez-le avant de poser une consigne temporaire.",
        )
    if isinstance(err, schedule_module.InvalidTemperatureError):
        return "invalid_temperature", str(err)
    if isinstance(err, InvalidDurationError):
        return "invalid_duration", str(err)
    return None


def parse_temporary_end(
    duration_minutes: int | None, until: str | None
) -> tuple[timedelta | None, datetime | None]:
    """Durée en minutes ou heure de fin « HH:MM » (prochaine occurrence
    locale), exactement une des deux ; commun au panneau et aux outils
    LLM. Lève `InvalidDurationError`."""
    if (duration_minutes is None) == (until is None):
        raise InvalidDurationError("Indiquer soit une durée, soit une heure de fin.")
    if duration_minutes is not None:
        return timedelta(minutes=duration_minutes), None
    try:
        minutes = llm_format.hhmm_to_minutes(until)
    except ValueError as err:
        raise InvalidDurationError(str(err)) from err
    return None, llm_format.next_occurrence(dt_util.now(), minutes)


TEMPORARY_TARGET_ERRORS = (
    RoomWithoutRadiatorError,
    radiators_module.RFPlayerNotConfiguredError,
    RoomNotRegulatedError,
    VacationModeActiveError,
    schedule_module.InvalidTemperatureError,
    InvalidDurationError,
)


# Provenance de la consigne effective (spec 012, data-model).
SOURCE_SCHEDULE = "schedule"
SOURCE_DEFAULT = "default"
SOURCE_VACATION = "vacation"
SOURCE_TEMPORARY = "temporary"


@dataclass
class TemporaryTarget:
    """Dérogation au planning d'une pièce, en mémoire uniquement
    (spec 012, research R10)."""

    temperature: float
    until: datetime
    origin: str
    set_at: datetime

    def as_dict(self) -> dict[str, Any]:
        return {
            "temperature": self.temperature,
            "until": self.until.isoformat(),
            "origin": self.origin,
        }


@dataclass(frozen=True)
class EffectiveTarget:
    """Consigne visée par la régulation et affichée (research R11)."""

    temperature: float
    source: str
    until: datetime | None = None


def schedule_target(
    room_schedule: dict[str, Any], settings: dict[str, Any], now: datetime
) -> EffectiveTarget:
    """Consigne issue de la programmation seule, avec sa provenance."""
    temperature = schedule_module.current_target(room_schedule, settings, now)
    program, _ = schedule_module.active_program(room_schedule, settings["vacation_mode"], now)
    if program == "vacation":
        return EffectiveTarget(temperature, SOURCE_VACATION)
    minute = now.hour * 60 + now.minute
    day = schedule_module.get_week(room_schedule, program)[now.weekday()]
    in_slot = any(slot["start"] <= minute < slot["end"] for slot in day)
    return EffectiveTarget(temperature, SOURCE_SCHEDULE if in_slot else SOURCE_DEFAULT)


def effective_target(
    hass: HomeAssistant,
    room_id: str,
    room_schedule: dict[str, Any],
    settings: dict[str, Any],
    now: datetime,
) -> EffectiveTarget:
    """Consigne effective d'une pièce, régulateur présent ou non ; seul
    point de calcul pour la régulation, les pièces et l'historique."""
    regulator = get_regulator(hass)
    if regulator is None:
        return schedule_target(room_schedule, settings, now)
    return regulator.effective_target(room_id, room_schedule, settings, now)


DEFAULT_STATUS: dict[str, Any] = {
    "status": STATUS_IDLE,
    "reason": Reason.HYSTERESIS_HOLD.value,
    "suspended_until": None,
    # Spec 012 : provenance de la consigne et consigne temporaire.
    "target_source": None,
    "temporary_target": None,
}


@dataclass
class RoomRegulation:
    """État en mémoire de la régulation d'une pièce (data-model.md)."""

    decision: Decision = regulation.OFF
    status: str | None = None
    reason: str | None = None
    suspended_until: datetime | None = None
    last_sent: dict[str, datetime] = field(default_factory=dict)
    temporary_target: TemporaryTarget | None = None
    target_source: str | None = None

    def as_dict(self) -> dict[str, Any]:
        temporary = self.temporary_target.as_dict() if self.temporary_target else None
        if self.status is None:
            return {**DEFAULT_STATUS, "temporary_target": temporary}
        return {
            "status": self.status,
            "reason": self.reason,
            "suspended_until": (
                self.suspended_until.isoformat() if self.suspended_until else None
            ),
            "target_source": self.target_source,
            "temporary_target": temporary,
        }


def get_regulator(hass: HomeAssistant) -> Regulator | None:
    return hass.data.get(DOMAIN, {}).get("regulator")


def sensor_reading(
    hass: HomeAssistant, entity_id: str | None, now: datetime
) -> tuple[SensorHealth, float | None]:
    """Classe la sonde d'une pièce (data-model.md, `SensorHealth`).
    Partagée avec l'historique (spec 010, research R2)."""
    if entity_id is None:
        return SensorHealth.NONE, None
    state = hass.states.get(entity_id)
    if state is None:
        return SensorHealth.MISSING, None
    if state.state in (STATE_UNAVAILABLE, STATE_UNKNOWN):
        return SensorHealth.UNAVAILABLE, None
    try:
        measured = float(state.state)
    except ValueError:
        return SensorHealth.INVALID, None
    if sensors_module.is_stale(state, now):
        return SensorHealth.STALE, None
    return SensorHealth.OK, measured


class Regulator:
    def __init__(
        self,
        hass: HomeAssistant,
        client: RFPlayerClient | None,
        policy: RegulationPolicy | None = None,
    ) -> None:
        self.hass = hass
        self.client = client
        self.policy: RegulationPolicy = policy or regulation.HysteresisPolicy()
        self._rooms: dict[str, RoomRegulation] = {}
        self._lock = asyncio.Lock()
        self._unsubs: list[Any] = []
        self._sensor_unsub: Any = None
        self._entity_rooms: dict[str, str] = {}
        # Spec 011 (FR-002) : dernier arrêt transmis aux radiateurs sans pièce.
        self._roomless_last_sent: dict[str, datetime] = {}

    # --- Cycle de vie ---

    async def async_start(self) -> None:
        """Branche les déclencheurs (FR-007, research R4) puis évalue
        toutes les pièces une première fois."""
        hass = self.hass
        self._unsubs.append(
            async_track_time_interval(hass, self._async_tick, REGULATION_TICK)
        )
        self._unsubs.append(hass.bus.async_listen(EVENT_SCHEDULE_UPDATED, self._on_change))
        self._unsubs.append(hass.bus.async_listen("area_registry_updated", self._on_change))
        self._unsubs.append(
            async_dispatcher_connect(hass, SIGNAL_RADIATORS_CHANGED, self._on_change)
        )
        await self._async_resubscribe_sensors()
        await self.async_evaluate()

    async def async_stop(self) -> None:
        # Spec 012 : les consignes temporaires ne survivent pas à l'arrêt.
        for state in self._rooms.values():
            state.temporary_target = None
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()
        if self._sensor_unsub is not None:
            self._sensor_unsub()
            self._sensor_unsub = None

    async def _async_resubscribe_sensors(self) -> None:
        """Suit les sondes des pièces équipées d'un radiateur ; la table
        est reconstruite à chaque changement de zone ou de radiateur."""
        if self._sensor_unsub is not None:
            self._sensor_unsub()
            self._sensor_unsub = None
        area_registry = ar.async_get(self.hass)
        room_ids = {r["room_id"] for r in await radiators_module.async_list_radiators(self.hass)}
        room_ids.discard(None)  # radiateurs sans pièce (spec 009)
        self._entity_rooms = {}
        for room_id in room_ids:
            area = area_registry.async_get_area(room_id)
            if area is not None and area.temperature_entity_id is not None:
                self._entity_rooms[area.temperature_entity_id] = room_id
        if self._entity_rooms:
            self._sensor_unsub = async_track_state_change_event(
                self.hass, list(self._entity_rooms), self._on_sensor_change
            )

    # --- Déclencheurs ---

    async def _async_tick(self, _now: datetime) -> None:
        await self.async_evaluate()

    @callback
    def _on_change(self, _event: Event | None = None) -> None:
        async def _run() -> None:
            await self._async_resubscribe_sensors()
            await self.async_evaluate()

        self.hass.async_create_task(_run())

    @callback
    def _on_sensor_change(self, event: Event) -> None:
        room_id = self._entity_rooms.get(event.data["entity_id"])
        if room_id is not None:
            self.hass.async_create_task(self.async_evaluate([room_id]))

    # --- Pilotage manuel (FR-015, research R6) ---

    async def async_manual_heating(
        self, radiator_id: str, *, heating: bool
    ) -> dict[str, Any]:
        """Ordre manuel puis suspension de la pièce, sous le même verrou
        que l'évaluation : aucun tick ne s'intercale entre les deux."""
        async with self._lock:
            radiator = await radiators_module.async_set_heating(
                self.hass,
                self.client,
                radiator_id,
                heating=heating,
                on_expire=self.async_manual_expired,
            )
            state = self._suspend(radiator["room_id"])
            # Spec 011 (R2) : premier renvoi 5 min après l'ordre manuel.
            state.last_sent[radiator_id] = dt_util.now()
        self._fire([radiator["room_id"]])
        return radiator

    async def async_room_manual_heating(self, room_id: str) -> list[str]:
        """« Chauffer 1 h » (spec 011 FR-005 à FR-007, research R4) : ordre
        manuel de chauffe à chaque radiateur de la pièce (minuterie d'1 h
        relancée à chaque appui) puis suspension de la pièce. Renvoie les
        radiateurs que le dongle n'a pas pu atteindre ; lève
        `RFPlayerUnreachable` si aucun ne l'a été."""
        async with self._lock:
            room_radiators = await self._room_radiators_or_raise(room_id)
            state = self._rooms.setdefault(room_id, RoomRegulation())
            now = dt_util.now()
            failed: list[str] = []
            for radiator in room_radiators:
                radiator_id = radiator["radiator_id"]
                try:
                    await radiators_module.async_set_heating(
                        self.hass,
                        self.client,
                        radiator_id,
                        heating=True,
                        on_expire=self.async_manual_expired,
                    )
                except RFPlayerUnreachable:
                    failed.append(radiator_id)
                    _LOGGER.warning(
                        "Dongle injoignable : chauffe manuelle non transmise au "
                        "radiateur %s",
                        radiator_id,
                    )
                else:
                    state.last_sent[radiator_id] = now
            if len(failed) == len(room_radiators):
                raise RFPlayerUnreachable("aucun radiateur atteint")
            self._suspend(room_id)
        self._fire([room_id])
        return failed

    async def async_end_room_manual_heating(self, room_id: str) -> list[str]:
        """« Arrêter la chauffe » (spec 011 FR-008, research R4) : arrêt
        explicite des radiateurs en chauffe, fin de la suspension, puis
        réévaluation immédiate de la pièce avec envoi forcé."""
        async with self._lock:
            room_radiators = await self._room_radiators_or_raise(room_id)
            failed: list[str] = []
            heating = [r for r in room_radiators if r["heating"]]
            for radiator in room_radiators:
                radiator_id = radiator["radiator_id"]
                if not radiator["heating"]:
                    radiators_module.cancel_auto_off(self.hass, radiator_id)
                    continue
                try:
                    await radiators_module.async_set_heating(
                        self.hass, self.client, radiator_id, heating=False
                    )
                except RFPlayerUnreachable:
                    failed.append(radiator_id)
            if heating and len(failed) == len(heating):
                raise RFPlayerUnreachable("aucun radiateur atteint")
            state = self._rooms.setdefault(room_id, RoomRegulation())
            state.suspended_until = None
            state.decision = regulation.OFF
            state.last_sent.clear()  # envoi forcé à la réévaluation
            await self._async_evaluate_locked([room_id])
        self._fire([room_id])
        return failed

    # --- Consigne temporaire (spec 012, research R10-R12) ---

    def effective_target(
        self,
        room_id: str,
        room_schedule: dict[str, Any],
        settings: dict[str, Any],
        now: datetime,
    ) -> EffectiveTarget:
        """Consigne temporaire si elle est active, non expirée et que le
        mode vacances est inactif ; sinon la programmation."""
        state = self._rooms.get(room_id)
        temporary = state.temporary_target if state is not None else None
        if (
            temporary is not None
            and not settings["vacation_mode"]
            and now < temporary.until
        ):
            return EffectiveTarget(temporary.temperature, SOURCE_TEMPORARY, temporary.until)
        return schedule_target(room_schedule, settings, now)

    async def async_set_temporary_target(
        self,
        room_id: str,
        temperature: float,
        *,
        duration: timedelta | None = None,
        until: datetime | None = None,
        origin: str,
    ) -> tuple[TemporaryTarget, bool]:
        """Pose (ou remplace) la consigne temporaire d'une pièce régulée,
        pour `duration` ou jusqu'à `until` (exactement un des deux), puis
        réévalue la pièce. Renvoie la dérogation et si elle en remplaçait
        une. Lève `RoomWithoutRadiatorError`,
        `radiators.RFPlayerNotConfiguredError`, `RoomNotRegulatedError`,
        `VacationModeActiveError`, `schedule.InvalidTemperatureError` ou
        `InvalidDurationError` sans rien modifier (data-model)."""
        now = dt_util.now()
        if (duration is None) == (until is None):
            raise InvalidDurationError("Indiquer soit une durée, soit une heure de fin.")
        end = now + duration if duration is not None else until
        assert end is not None
        if not TEMPORARY_TARGET_MIN <= end - now <= TEMPORARY_TARGET_MAX:
            raise InvalidDurationError(
                "La consigne temporaire doit durer entre 30 min et 24 h."
            )
        async with self._lock:
            await self._room_radiators_or_raise(room_id)
            area = ar.async_get(self.hass).async_get_area(room_id)
            if area is None or area.temperature_entity_id is None:
                raise RoomNotRegulatedError(room_id)
            settings = await schedules_store.async_get_settings(self.hass)
            if settings["vacation_mode"]:
                raise VacationModeActiveError(room_id)
            schedule_module.validate_temperature(temperature)
            state = self._rooms.setdefault(room_id, RoomRegulation())
            replaced = state.temporary_target is not None
            state.temporary_target = TemporaryTarget(
                temperature=temperature,
                until=dt_util.as_utc(end),
                origin=origin,
                set_at=dt_util.utcnow(),
            )
            target = state.temporary_target
            await self._async_evaluate_locked([room_id])
        self._fire([room_id])
        return target, replaced

    def temporary_target_rooms(self) -> list[str]:
        """Pièces ayant une consigne temporaire en cours."""
        return [
            room_id for room_id, state in self._rooms.items() if state.temporary_target
        ]

    async def async_clear_temporary_target(self, room_id: str) -> bool:
        """Annule la consigne temporaire d'une pièce ; `False` s'il n'y
        en avait pas (aucune erreur)."""
        async with self._lock:
            state = self._rooms.get(room_id)
            if state is None or state.temporary_target is None:
                return False
            state.temporary_target = None
            await self._async_evaluate_locked([room_id])
        self._fire([room_id])
        return True

    async def _room_radiators_or_raise(self, room_id: str) -> list[dict[str, Any]]:
        room_radiators = await radiators_module.async_list_radiators(self.hass, room_id)
        if not room_radiators:
            raise RoomWithoutRadiatorError(room_id)
        if self.client is None:
            raise radiators_module.RFPlayerNotConfiguredError()
        return room_radiators

    async def async_manual_expired(self, radiator_id: str, token: object) -> None:
        """Échéance d'1 h d'une chauffe manuelle (spec 003 FR-020),
        exécutée sous le verrou pour ne jamais croiser un renvoi (spec 011,
        research R3). Sans effet si la minuterie a été relancée ou
        annulée pendant que l'échéance attendait le verrou (analyse U1)."""
        async with self._lock:
            if not radiators_module.pop_auto_off_if(self.hass, radiator_id, token):
                return
            try:
                radiator = await radiators_module.async_get_radiator(
                    self.hass, radiator_id
                )
            except radiators_module.RadiatorNotFoundError:
                return
            room_id = radiator["room_id"]
            last_sent = (
                self._rooms.setdefault(room_id, RoomRegulation()).last_sent
                if room_id is not None
                else self._roomless_last_sent
            )
            try:
                await radiators_module.async_apply_regulation(
                    self.hass, self.client, radiator_id, heating=False
                )
            except (RFPlayerUnreachable, radiators_module.RFPlayerNotConfiguredError):
                _LOGGER.warning(
                    "Dongle injoignable : impossible d'envoyer l'ordre d'arrêt "
                    "automatique au radiateur %s ; nouvel essai au prochain renvoi",
                    radiator_id,
                )
                # L'arrêt est dû : l'état passe à « arrêt » et le renvoi le
                # retentera (FR-002), plutôt que de laisser « en chauffe ».
                await radiators_module.async_mark_stopped(self.hass, radiator_id)
                last_sent.pop(radiator_id, None)
            else:
                last_sent[radiator_id] = dt_util.now()
        if room_id is not None:
            self._fire([room_id])

    async def async_suspend_room(self, room_id: str) -> None:
        async with self._lock:
            self._suspend(room_id)
        self._fire([room_id])

    def _suspend(self, room_id: str) -> RoomRegulation:
        state = self._rooms.setdefault(room_id, RoomRegulation())
        state.suspended_until = dt_util.utcnow() + MANUAL_SUSPENSION
        self._set_suspended_status(state, ar.async_get(self.hass).async_get_area(room_id))
        return state

    @staticmethod
    def _set_suspended_status(state: RoomRegulation, area: ar.AreaEntry | None) -> None:
        """Une pièce sans sonde n'est pas régulée : la suspension y est
        mémorisée (au cas où une sonde serait associée entre-temps) mais
        l'affichage reste « non régulée »."""
        if area is not None and area.temperature_entity_id is None:
            state.status, state.reason = STATUS_NOT_REGULATED, Reason.NO_SENSOR.value
        else:
            state.status, state.reason = STATUS_SUSPENDED, REASON_MANUAL

    # --- Évaluation ---

    def room_status(self, room_id: str) -> dict[str, Any]:
        state = self._rooms.get(room_id)
        return state.as_dict() if state is not None else dict(DEFAULT_STATUS)

    async def async_evaluate(self, room_ids: list[str] | None = None) -> None:
        """Réévalue les pièces données (toutes par défaut) et émet
        `heatwise_regulation_updated` pour celles dont l'état a changé."""
        async with self._lock:
            changed = await self._async_evaluate_locked(room_ids)
        if changed:
            self._fire(changed)

    async def _async_evaluate_locked(self, only: list[str] | None) -> list[str]:
        hass = self.hass
        now = dt_util.now()
        area_registry = ar.async_get(hass)
        all_radiators = await radiators_module.async_list_radiators(hass)
        all_schedules = await schedules_store.async_get_all(hass)

        removed = await self._async_reconcile_locked(
            area_registry, all_radiators, all_schedules
        )
        if removed:
            all_radiators = await radiators_module.async_list_radiators(hass)

        by_room: dict[str, list[dict[str, Any]]] = {}
        roomless: list[dict[str, Any]] = []
        for radiator in all_radiators:
            if radiator["room_id"] is None:
                roomless.append(radiator)
            else:
                by_room.setdefault(radiator["room_id"], []).append(radiator)
        await self._async_stop_roomless(roomless, now)

        # Pièces sans radiateur : plus rien à réguler.
        for room_id in list(self._rooms):
            if room_id not in by_room:
                del self._rooms[room_id]

        changed: list[str] = list(removed)
        for room_id, room_radiators in by_room.items():
            if only is not None and room_id not in only:
                continue
            area = area_registry.async_get_area(room_id)
            if area is None:  # zone supprimée depuis la réconciliation
                continue
            if await self._async_evaluate_room(
                room_id, area, room_radiators, all_schedules, now
            ):
                changed.append(room_id)
        return changed

    async def _async_reconcile_locked(
        self,
        area_registry: ar.AreaRegistry,
        all_radiators: list[dict[str, Any]],
        all_schedules: dict[str, Any],
    ) -> list[str]:
        """Oublie les pièces dont la zone n'existe plus (spec 009, research
        R3) : leurs radiateurs deviennent « sans pièce », leur
        programmation et leur état de régulation sont retirés.

        Le statut est écrit, pas déduit de l'absence de la zone : Home
        Assistant redonne le même identifiant à une zone recréée sous le
        même nom, qui doit partir vierge (research R2). Exécutée à chaque
        évaluation, donc aussi au démarrage pour les zones supprimées
        pendant l'arrêt (FR-014). `all_schedules` est mis à jour en place.
        """
        existing = {area.id for area in area_registry.async_list_areas()}
        known = {r["room_id"] for r in all_radiators if r["room_id"] is not None}
        known |= set(all_schedules["rooms"])
        known |= set(self._rooms)
        missing = sorted(known - existing)
        if not missing:
            return []
        await radiators_module.async_detach_radiators(self.hass, missing)
        await schedules_store.async_remove_rooms(self.hass, missing)
        for room_id in missing:
            all_schedules["rooms"].pop(room_id, None)
            self._rooms.pop(room_id, None)
        return missing

    async def _async_stop_roomless(
        self, roomless: list[dict[str, Any]], now: datetime
    ) -> None:
        """Radiateurs sans pièce : arrêt immédiat s'ils chauffent (principe
        I, spec 009 FR-012, FR-015), puis renvoi de l'arrêt toutes les
        5 min (spec 011 FR-002). En cas d'échec, l'état reste inchangé et
        l'arrêt est retenté à l'évaluation suivante (tick de 60 s) ; la
        minuterie de chauffe manuelle éventuelle n'est annulée qu'après un
        arrêt transmis."""
        roomless_ids = {r["radiator_id"] for r in roomless}
        for radiator_id in list(self._roomless_last_sent):
            if radiator_id not in roomless_ids:
                del self._roomless_last_sent[radiator_id]
        if self.client is None:
            return
        for radiator in roomless:
            radiator_id = radiator["radiator_id"]
            last = self._roomless_last_sent.get(radiator_id)
            if not (
                radiator["heating"] or last is None or now - last >= REGULATION_RESEND
            ):
                continue
            try:
                await radiators_module.async_apply_regulation(
                    self.hass, self.client, radiator_id, heating=False
                )
            except RFPlayerUnreachable:
                _LOGGER.warning(
                    "Dongle injoignable : impossible d'arrêter le radiateur "
                    "sans pièce %s ; nouvel essai à la prochaine évaluation",
                    radiator_id,
                )
            else:
                self._roomless_last_sent[radiator_id] = now
                radiators_module.cancel_auto_off(self.hass, radiator_id)

    async def _async_evaluate_room(
        self,
        room_id: str,
        area: ar.AreaEntry,
        room_radiators: list[dict[str, Any]],
        all_schedules: dict[str, Any],
        now: datetime,
    ) -> bool:
        state = self._rooms.setdefault(room_id, RoomRegulation())
        before = self._snapshot(state, room_radiators)
        settings = all_schedules["settings"]
        room_schedule = all_schedules["rooms"].get(
            room_id, schedule_module.empty_room_schedule()
        )

        # Spec 012 (FR-013a) : une consigne temporaire expirée, rendue
        # caduque par le mode vacances ou par le retrait de la sonde est
        # annulée ; la pièce revient à sa programmation.
        temporary = state.temporary_target
        if temporary is not None and (
            now >= temporary.until
            or settings["vacation_mode"]
            or area.temperature_entity_id is None
        ):
            state.temporary_target = None
        target = self.effective_target(room_id, room_schedule, settings, now)
        state.target_source = target.source

        if state.suspended_until is not None:
            if now < state.suspended_until:
                self._set_suspended_status(state, area)
                if self.client is not None:
                    await self._async_resend_manual(state, area, room_radiators, now)
                    room_radiators = await radiators_module.async_list_radiators(
                        self.hass, room_id
                    )
                return self._snapshot(state, room_radiators) != before
            # Fin de suspension : la régulation reprend la main (R6) et
            # annule les minuteries manuelles résiduelles — seulement si la
            # pièce a une sonde ; sinon la chauffe manuelle doit garder son
            # arrêt automatique d'1 h (spec 003 FR-020, principe I).
            if area.temperature_entity_id is not None:
                await radiators_module.async_cancel_room_auto_off(self.hass, room_id)
            state.suspended_until = None
            state.decision = Decision(
                any(r["heating"] for r in room_radiators), Reason.HYSTERESIS_HOLD
            )

        if self.client is None:
            state.decision = regulation.OFF
            state.status = STATUS_NOT_REGULATED
            state.reason = REASON_RFPLAYER_NOT_CONFIGURED
            return self._snapshot(state, room_radiators) != before

        health, measured = sensor_reading(self.hass, area.temperature_entity_id, now)
        inputs = RoomInputs(
            now=now,
            room_id=room_id,
            target=target.temperature,
            measured=measured,
            sensor=health,
            previous=state.decision,
        )
        decision = regulation.decide(inputs, self.policy)

        if decision.reason == Reason.NO_SENSOR:
            # Pièce non régulée (FR-002 de la spec 008) : jamais de chauffe
            # hors suspension manuelle. Spec 011 (FR-002) : l'arrêt est
            # renvoyé toutes les 5 min ; il est forcé quand la sonde vient
            # d'être retirée d'une pièce régulée.
            await self._async_send(
                state,
                room_radiators,
                False,
                now,
                force=state.status not in (None, STATUS_NOT_REGULATED),
            )
            for radiator in await radiators_module.async_list_radiators(
                self.hass, room_id
            ):
                if not radiator["heating"]:
                    radiators_module.cancel_auto_off(
                        self.hass, radiator["radiator_id"]
                    )
            state.decision = regulation.OFF
            state.status = STATUS_NOT_REGULATED
            state.reason = Reason.NO_SENSOR.value
            room_radiators = await radiators_module.async_list_radiators(
                self.hass, room_id
            )
            return self._snapshot(state, room_radiators) != before

        safety = decision.reason in _SAFETY_REASONS
        # Après un arrêt de sécurité, l'hystérésis repart de « arrêt » (FR-005).
        state.decision = regulation.OFF if safety else decision
        unreachable = await self._async_send(
            state, room_radiators, decision.heating, now
        )

        if safety:
            state.status, state.reason = STATUS_SAFETY_STOP, decision.reason.value
        elif unreachable:
            state.status, state.reason = STATUS_SAFETY_STOP, REASON_DONGLE_UNREACHABLE
        else:
            state.status = STATUS_HEATING if decision.heating else STATUS_IDLE
            state.reason = decision.reason.value

        room_radiators = await radiators_module.async_list_radiators(self.hass, room_id)
        return self._snapshot(state, room_radiators) != before

    async def _async_send(
        self,
        state: RoomRegulation,
        room_radiators: list[dict[str, Any]],
        heating: bool,
        now: datetime,
        *,
        force: bool = False,
    ) -> bool:
        """Émet l'ordre vers chaque radiateur qui en a besoin (FR-012,
        FR-013). Retourne vrai si le dongle a été injoignable (FR-014)."""
        unreachable = False
        for radiator in room_radiators:
            radiator_id = radiator["radiator_id"]
            last = state.last_sent.get(radiator_id)
            due = (
                force
                or radiator["heating"] != heating
                or last is None
                or now - last >= REGULATION_RESEND
            )
            if not due:
                continue
            try:
                await radiators_module.async_apply_regulation(
                    self.hass, self.client, radiator_id, heating=heating
                )
            except RFPlayerUnreachable:
                unreachable = True
                state.last_sent.pop(radiator_id, None)
                _LOGGER.warning(
                    "Dongle injoignable : ordre de régulation non transmis au "
                    "radiateur %s",
                    radiator_id,
                )
            else:
                state.last_sent[radiator_id] = now
        return unreachable

    async def _async_resend_manual(
        self,
        state: RoomRegulation,
        area: ar.AreaEntry,
        room_radiators: list[dict[str, Any]],
        now: datetime,
    ) -> None:
        """Pièce suspendue (spec 011, FR-002, research R2/R3) : renvoie à
        chaque radiateur dû son état transmis, sans décision de régulation.
        « Marche » n'est renvoyé que pour une chauffe encore bornée : une
        minuterie d'arrêt automatique active, ou une pièce régulée (qui
        reprend la main à la fin de la suspension). Sinon : arrêt."""
        regulated = area.temperature_entity_id is not None
        for radiator in room_radiators:
            radiator_id = radiator["radiator_id"]
            last = state.last_sent.get(radiator_id)
            if last is not None and now - last < REGULATION_RESEND:
                continue
            heating = radiator["heating"] and (
                regulated or radiators_module.has_auto_off(self.hass, radiator_id)
            )
            try:
                await radiators_module.async_apply_regulation(
                    self.hass, self.client, radiator_id, heating=heating
                )
            except RFPlayerUnreachable:
                state.last_sent.pop(radiator_id, None)
                _LOGGER.warning(
                    "Dongle injoignable : ordre manuel non renvoyé au radiateur %s",
                    radiator_id,
                )
            else:
                state.last_sent[radiator_id] = now

    @staticmethod
    def _snapshot(
        state: RoomRegulation, room_radiators: list[dict[str, Any]]
    ) -> tuple[Any, ...]:
        return (
            state.status,
            state.reason,
            state.suspended_until,
            state.temporary_target,
            state.target_source,
            tuple(sorted((r["radiator_id"], r["heating"]) for r in room_radiators)),
        )

    @callback
    def _fire(self, room_ids: list[str]) -> None:
        self.hass.bus.async_fire(EVENT_REGULATION_UPDATED, {"room_ids": room_ids})
