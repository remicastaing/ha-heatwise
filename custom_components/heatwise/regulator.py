"""Contrôleur de la régulation automatique (spec 008).

Le `Regulator` relie Home Assistant à la décision pure de
`regulation.py` : il collecte les entrées de chaque pièce (consigne de
la programmation, mesure de la sonde), applique la décision à tous les
radiateurs de la pièce via `radiators.async_apply_regulation`, renvoie
l'ordre courant toutes les 15 min, suspend une pièce 1 h après une
action manuelle, et expose l'état de chaque pièce au panneau.

Il ne connaît pas l'algorithme : changer de politique ne touche que
`regulation.py` (cf. contracts/regulation-policy.md). Une seule
instance, dans `hass.data[DOMAIN]["regulator"]`, créée par
`__init__.py` après l'arrêt de tous les radiateurs au démarrage.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime
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

DEFAULT_STATUS: dict[str, Any] = {
    "status": STATUS_IDLE,
    "reason": Reason.HYSTERESIS_HOLD.value,
    "suspended_until": None,
}


@dataclass
class RoomRegulation:
    """État en mémoire de la régulation d'une pièce (data-model.md)."""

    decision: Decision = regulation.OFF
    status: str | None = None
    reason: str | None = None
    suspended_until: datetime | None = None
    last_sent: dict[str, datetime] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        if self.status is None:
            return dict(DEFAULT_STATUS)
        return {
            "status": self.status,
            "reason": self.reason,
            "suspended_until": (
                self.suspended_until.isoformat() if self.suspended_until else None
            ),
        }


def get_regulator(hass: HomeAssistant) -> Regulator | None:
    return hass.data.get(DOMAIN, {}).get("regulator")


def _sensor_reading(
    hass: HomeAssistant, entity_id: str | None, now: datetime
) -> tuple[SensorHealth, float | None]:
    """Classe la sonde d'une pièce (data-model.md, `SensorHealth`)."""
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
                self.hass, self.client, radiator_id, heating=heating
            )
            self._suspend(radiator["room_id"])
        self._fire([radiator["room_id"]])
        return radiator

    async def async_suspend_room(self, room_id: str) -> None:
        async with self._lock:
            self._suspend(room_id)
        self._fire([room_id])

    def _suspend(self, room_id: str) -> None:
        state = self._rooms.setdefault(room_id, RoomRegulation())
        state.suspended_until = dt_util.utcnow() + MANUAL_SUSPENSION
        self._set_suspended_status(state, ar.async_get(self.hass).async_get_area(room_id))

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

        by_room: dict[str, list[dict[str, Any]]] = {}
        for radiator in all_radiators:
            by_room.setdefault(radiator["room_id"], []).append(radiator)

        # Pièces sans radiateur : plus rien à réguler.
        for room_id in list(self._rooms):
            if room_id not in by_room:
                del self._rooms[room_id]

        changed: list[str] = []
        for room_id, room_radiators in by_room.items():
            if only is not None and room_id not in only:
                continue
            area = area_registry.async_get_area(room_id)
            if area is None:
                await self._async_stop_orphans(room_radiators)
                continue
            if await self._async_evaluate_room(
                room_id, area, room_radiators, all_schedules, now
            ):
                changed.append(room_id)
        return changed

    async def _async_stop_orphans(self, room_radiators: list[dict[str, Any]]) -> None:
        """Radiateurs d'une pièce supprimée encore en chauffe : arrêt
        (principe I, analyse U1)."""
        for radiator in room_radiators:
            if radiator["heating"] and self.client is not None:
                try:
                    await radiators_module.async_apply_regulation(
                        self.hass, self.client, radiator["radiator_id"], heating=False
                    )
                except RFPlayerUnreachable:
                    _LOGGER.warning(
                        "Dongle injoignable : impossible d'arrêter le radiateur "
                        "orphelin %s",
                        radiator["radiator_id"],
                    )

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

        if state.suspended_until is not None:
            if now < state.suspended_until:
                self._set_suspended_status(state, area)
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

        room_schedule = all_schedules["rooms"].get(
            room_id, schedule_module.empty_room_schedule()
        )
        health, measured = _sensor_reading(self.hass, area.temperature_entity_id, now)
        inputs = RoomInputs(
            now=now,
            room_id=room_id,
            target=schedule_module.current_target(
                room_schedule, all_schedules["settings"], now
            ),
            measured=measured,
            sensor=health,
            previous=state.decision,
        )
        decision = regulation.decide(inputs, self.policy)

        if decision.reason == Reason.NO_SENSOR:
            # Pièce non régulée (FR-002) : on ne pilote pas ses radiateurs
            # (pilotage manuel seul), sauf pour arrêter une chauffe
            # régulée en cours quand la sonde vient d'être retirée.
            if state.status not in (None, STATUS_NOT_REGULATED):
                await self._async_send(state, room_radiators, False, now, force=True)
            state.decision = regulation.OFF
            state.status = STATUS_NOT_REGULATED
            state.reason = Reason.NO_SENSOR.value
            state.last_sent.clear()
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

    @staticmethod
    def _snapshot(
        state: RoomRegulation, room_radiators: list[dict[str, Any]]
    ) -> tuple[Any, ...]:
        return (
            state.status,
            state.reason,
            state.suspended_until,
            tuple(sorted((r["radiator_id"], r["heating"]) for r in room_radiators)),
        )

    @callback
    def _fire(self, room_ids: list[str]) -> None:
        self.hass.bus.async_fire(EVENT_REGULATION_UPDATED, {"room_ids": room_ids})
