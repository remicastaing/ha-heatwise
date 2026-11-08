"""Contrôleur de l'historique des mesures (spec 010).

Chaque minute pile, le `HistoryRecorder` échantillonne la température et
l'humidité de chaque pièce avec les règles de validité de la régulation
(`regulator.sensor_reading`) et, à chaque borne de la fréquence réglée,
enregistre la moyenne de l'intervalle (research R2, R3). Il enregistre
aussi, à la minute près et à chaque `heatwise_regulation_updated`, la
consigne, la chauffe et l'état de régulation de chaque pièce quand ils
changent (R5).

Il ne fait que lire : aucune action sur les radiateurs ni sur la
régulation, et une panne de la base est journalisée sans jamais être
propagée (principe I, research R8). Toutes les opérations SQLite passent
par l'exécuteur (principe V). Une seule instance, dans
`hass.data[DOMAIN]["history"]`.
"""
from __future__ import annotations

import asyncio
from datetime import datetime
import logging
from typing import Any

from homeassistant.const import EVENT_HOMEASSISTANT_FINAL_WRITE
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers.event import async_track_utc_time_change
from homeassistant.util import dt as dt_util

from . import radiators as radiators_module
from . import schedule as schedule_module
from . import schedules_store
from . import sensors as sensors_module
from .const import (
    DOMAIN,
    EVENT_REGULATION_UPDATED,
    EVENT_SCHEDULE_UPDATED,
    HISTORY_DB_FILENAME,
    HISTORY_PERIOD_STEPS,
    HISTORY_PERIODS,
    HISTORY_STATUS_NO_RADIATOR,
)
from .history import (
    MeasurementPoint,
    RegulationState,
    Sampler,
    bucket_seconds,
    fill_grid,
    grid_bounds,
    is_boundary,
)
from .history_store import HistoryStore
from .regulation import SensorHealth
from .regulator import (
    STATUS_NOT_REGULATED,
    effective_target,
    get_regulator,
    sensor_reading,
)

_LOGGER = logging.getLogger(__name__)


class HistoryUnavailableError(Exception):
    """Base d'historique absente ou illisible (FR-013d)."""


def history_db_path(hass: HomeAssistant) -> str:
    """Seul point de résolution du chemin de la base (research R8bis)."""
    return hass.config.path(HISTORY_DB_FILENAME)


def get_history_recorder(hass: HomeAssistant) -> HistoryRecorder | None:
    return hass.data.get(DOMAIN, {}).get("history")


def _created(area: ar.AreaEntry) -> str:
    return area.created_at.isoformat()


def _iso(ts: int) -> str:
    return dt_util.utc_from_timestamp(ts).isoformat()


class HistoryRecorder:
    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store: HistoryStore | None = None
        self._samplers: dict[str, Sampler] = {}
        self._last_states: dict[int, RegulationState] = {}
        self._interval = 0
        # Spec 013 : source et échantillonneur de la température extérieure.
        self._outdoor_entity_id: str | None = None
        self._outdoor_sampler: Sampler | None = None
        self._last_tick: int | None = None
        self._lock = asyncio.Lock()
        self._unsubs: list[Any] = []
        self._stopped = False

    async def async_export(self, dest: str) -> None:
        """Écrit une copie de la base dans `dest` (spec 013, téléchargement)."""
        store = self._store
        if store is None:
            raise HistoryUnavailableError
        try:
            await self.hass.async_add_executor_job(store.export_copy, dest)
        except Exception as err:  # noqa: BLE001 — sans effet sur l'enregistrement
            _LOGGER.exception("Export de la base d'historique Heatwise impossible")
            raise HistoryUnavailableError from err

    # --- Cycle de vie ---

    async def async_start(self) -> None:
        hass = self.hass
        try:
            self._store = await hass.async_add_executor_job(
                HistoryStore, history_db_path(hass)
            )
        except Exception:  # noqa: BLE001 — l'historique ne bloque jamais Heatwise
            _LOGGER.exception("Base d'historique Heatwise inutilisable ; historique désactivé")
            self._store = None
            return
        settings = await schedules_store.async_get_settings(hass)
        self._interval = settings["history_interval"]
        self._outdoor_entity_id = settings["outdoor_entity_id"]
        await self._async_reconcile()
        self._unsubs = [
            async_track_utc_time_change(hass, self._async_on_minute, second=0),
            hass.bus.async_listen(EVENT_SCHEDULE_UPDATED, self._on_schedule_updated),
            hass.bus.async_listen("area_registry_updated", self._on_areas_updated),
            hass.bus.async_listen(EVENT_REGULATION_UPDATED, self._on_regulation_updated),
            hass.bus.async_listen_once(EVENT_HOMEASSISTANT_FINAL_WRITE, self._on_final_write),
        ]
        await self.async_record_regulation()

    async def async_stop(self) -> None:
        """Clôt les intervalles en cours (durée réelle) puis ferme la base
        (research R10). Idempotent."""
        if self._stopped:
            return
        self._stopped = True
        for unsub in self._unsubs:
            try:
                unsub()
            except ValueError:  # écouteur `listen_once` déjà consommé
                pass
        self._unsubs.clear()
        if self._store is None:
            return
        async with self._lock:
            await self._async_close_samplers()
            store, self._store = self._store, None
        await self.hass.async_add_executor_job(store.close)

    async def _on_final_write(self, _event: Event) -> None:
        await self.async_stop()

    # --- Déclencheurs ---

    async def _async_on_minute(self, _now: datetime) -> None:
        # Minute courante lue à l'horloge de HA (identique à `_now` en
        # production) : le top transmis par le déclencheur peut différer
        # sous horloge simulée.
        ts = int(dt_util.utcnow().timestamp())
        ts -= ts % 60
        if self._last_tick is not None and ts <= self._last_tick:
            return
        async with self._lock:
            if self._store is None:
                return
            await self._async_sample(ts)
        await self.async_record_regulation(ts)

    @callback
    def _on_schedule_updated(self, event: Event) -> None:
        if event.data.get("room_ids") is None:
            self.hass.async_create_task(self._async_reload_interval())

    @callback
    def _on_areas_updated(self, _event: Event) -> None:
        self.hass.async_create_task(self._async_reconcile())

    @callback
    def _on_regulation_updated(self, event: Event) -> None:
        self.hass.async_create_task(
            self.async_record_regulation(room_ids=event.data.get("room_ids"))
        )

    # --- Mesures (research R2, R3) ---

    async def _async_sample(self, ts: int) -> None:
        points: list[tuple[str, str, MeasurementPoint]] = []
        now = dt_util.utc_from_timestamp(ts)
        areas = {area.id: area for area in ar.async_get(self.hass).async_list_areas()}
        for room_id in [r for r in self._samplers if r not in areas]:
            del self._samplers[room_id]
        for room_id, area in areas.items():
            sampler = self._samplers.get(room_id)
            if sampler is not None and is_boundary(ts, self._interval) and ts > sampler.start:
                point = sampler.close(ts)
                if point is not None:
                    points.append((room_id, _created(area), point))
                sampler = None
            if sampler is None:
                sampler = self._samplers[room_id] = Sampler(ts)
            sampler.add(
                self._read(area.temperature_entity_id, now),
                self._read(area.humidity_entity_id, now),
                has_sensor=(
                    area.temperature_entity_id is not None
                    or area.humidity_entity_id is not None
                ),
            )
        outdoor = self._sample_outdoor(ts, now)
        self._last_tick = ts
        await self._async_write_points(points, ts)
        await self._async_write_outdoor(outdoor)

    def _sample_outdoor(self, ts: int, now: datetime) -> MeasurementPoint | None:
        """Échantillon extérieur de la minute ; renvoie le point clos à une
        borne (spec 013, research R3)."""
        point = None
        sampler = self._outdoor_sampler
        if sampler is not None and is_boundary(ts, self._interval) and ts > sampler.start:
            point = sampler.close(ts)
            sampler = None
        if sampler is None:
            sampler = self._outdoor_sampler = Sampler(ts)
        health, value = sensors_module.outdoor_reading(self.hass, self._outdoor_entity_id, now)
        sampler.add(
            value if health is SensorHealth.OK else None,
            None,
            has_sensor=self._outdoor_entity_id is not None,
        )
        return point

    def _close_outdoor(self, end: int) -> MeasurementPoint | None:
        sampler = self._outdoor_sampler
        self._outdoor_sampler = Sampler(end)
        return sampler.close(end) if sampler is not None else None

    async def _async_write_outdoor(self, point: MeasurementPoint | None) -> None:
        if point is None or self._store is None:
            return
        try:
            await self.hass.async_add_executor_job(self._store.write_outdoor, point)
        except Exception:  # noqa: BLE001 — FR-008
            _LOGGER.exception("Écriture de la température extérieure impossible")

    def _read(self, entity_id: str | None, now: datetime) -> float | None:
        health, value = sensor_reading(self.hass, entity_id, now)
        return value if health is SensorHealth.OK else None

    async def _async_close_samplers(self) -> None:
        """Clôt tous les intervalles à la fin de la dernière minute
        échantillonnée et repart de là (changement de fréquence, arrêt)."""
        if self._last_tick is None:
            return
        end = self._last_tick + 60
        areas = {area.id: area for area in ar.async_get(self.hass).async_list_areas()}
        points = []
        for room_id, sampler in self._samplers.items():
            point = sampler.close(end)
            if point is not None and room_id in areas:
                points.append((room_id, _created(areas[room_id]), point))
        self._samplers = {room_id: Sampler(end) for room_id in self._samplers}
        outdoor = self._close_outdoor(end)
        await self._async_write_points(points, end)
        await self._async_write_outdoor(outdoor)

    async def _async_reload_interval(self) -> None:
        settings = await schedules_store.async_get_settings(self.hass)
        interval = settings["history_interval"]
        outdoor_entity_id = settings["outdoor_entity_id"]
        async with self._lock:
            if self._store is None:
                return
            if interval != self._interval:
                self._interval = interval
                self._outdoor_entity_id = outdoor_entity_id
                await self._async_close_samplers()
            elif outdoor_entity_id != self._outdoor_entity_id:
                # Spec 013 (research R3) : un point ne mélange jamais deux
                # sources ; seules les pièces gardent leur intervalle.
                self._outdoor_entity_id = outdoor_entity_id
                if self._last_tick is not None:
                    await self._async_write_outdoor(self._close_outdoor(self._last_tick + 60))

    async def _async_write_points(
        self, points: list[tuple[str, str, MeasurementPoint]], now: int
    ) -> None:
        if not points or self._store is None:
            return
        store = self._store

        def _write() -> None:
            for room_id, created, point in points:
                store.write_measurement(store.active_series(room_id, created, now), point)

        try:
            await self.hass.async_add_executor_job(_write)
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Écriture de l'historique Heatwise impossible")

    # --- Régulation (research R5) ---

    async def async_record_regulation(
        self, ts: int | None = None, room_ids: list[str] | None = None
    ) -> None:
        """Enregistre l'état des pièces données (toutes par défaut) s'il a
        changé depuis la dernière ligne de leur série."""
        if self._store is None:
            return
        hass = self.hass
        if ts is None:
            ts = int(dt_util.utcnow().timestamp())
        now_local = dt_util.as_local(dt_util.utc_from_timestamp(ts))
        all_schedules = await schedules_store.async_get_all(hass)
        heating: dict[str, bool] = {}
        for radiator in await radiators_module.async_list_radiators(hass):
            if radiator["room_id"] is not None:
                heating[radiator["room_id"]] = (
                    heating.get(radiator["room_id"], False) or radiator["heating"]
                )
        regulator = get_regulator(hass)
        items: list[tuple[str, str, RegulationState]] = []
        for area in ar.async_get(hass).async_list_areas():
            if room_ids is not None and area.id not in room_ids:
                continue
            # Spec 012 : consigne effective (consigne temporaire comprise).
            target = effective_target(
                hass,
                area.id,
                all_schedules["rooms"].get(area.id, schedule_module.empty_room_schedule()),
                all_schedules["settings"],
                now_local,
            ).temperature
            if area.id not in heating:
                status, reason = HISTORY_STATUS_NO_RADIATOR, None
            elif regulator is not None:
                room_status = regulator.room_status(area.id)
                status, reason = room_status["status"], room_status["reason"]
            else:
                status, reason = STATUS_NOT_REGULATED, None
            state = RegulationState(target, heating.get(area.id, False), status, reason)
            items.append((area.id, _created(area), state))

        async with self._lock:
            store = self._store
            if store is None:
                return
            last_states = self._last_states

            def _write() -> None:
                for room_id, created, state in items:
                    series = store.active_series(room_id, created, ts)
                    last = last_states.get(series)
                    if last is None:
                        last = store.last_regulation(series)
                    if last != state:
                        store.write_regulation(series, ts, state)
                    last_states[series] = state

            try:
                await hass.async_add_executor_job(_write)
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Écriture de l'historique de régulation impossible")

    # --- Pièces supprimées (research R4) ---

    async def _async_reconcile(self) -> None:
        if self._store is None:
            return
        areas = ar.async_get(self.hass).async_list_areas()
        existing = {area.id: _created(area) for area in areas}
        now = int(dt_util.utcnow().timestamp())
        store = self._store
        try:
            detached = await self.hass.async_add_executor_job(
                store.detach_missing, existing, now
            )
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Rapprochement de l'historique Heatwise impossible")
            return
        for room_id in detached:
            self._samplers.pop(room_id, None)

    # --- Lecture (contracts/websocket-api.md) ---

    async def async_get_room_history(self, area: ar.AreaEntry, period: str) -> dict[str, Any]:
        store = self._store
        if store is None:
            raise HistoryUnavailableError
        period_seconds = int(HISTORY_PERIODS[period].total_seconds())
        step = HISTORY_PERIOD_STEPS[period]
        now = int(dt_util.utcnow().timestamp())
        pending = self._pending_point(area.id)

        pending_outdoor = self._pending_outdoor()

        def _read() -> tuple[int, int, int, dict, list, dict]:
            series = store.find_active_series(area.id, _created(area))
            if series is None:
                bucket = bucket_seconds(step, None)
                start, end = grid_bounds(now, period_seconds, bucket)
                return bucket, start, end, {}, [], store.read_outdoor(start, end, bucket)
            max_duration = store.max_duration(series, now - period_seconds - 3600, now)
            bucket = bucket_seconds(step, max_duration)
            start, end = grid_bounds(now, period_seconds, bucket)
            return (
                bucket,
                start,
                end,
                store.read_measurements(series, start, end, bucket),
                store.read_regulation(series, start, end),
                store.read_outdoor(start, end, bucket),
            )

        try:
            (
                bucket,
                start,
                end,
                buckets,
                regulation,
                outdoor_buckets,
            ) = await self.hass.async_add_executor_job(_read)
        except Exception as err:  # noqa: BLE001
            _LOGGER.exception("Lecture de l'historique Heatwise impossible")
            raise HistoryUnavailableError from err

        # Intervalle en cours, pas encore écrit : affiché s'il remplit une
        # case encore vide (bord droit du graphique).
        if pending is not None:
            case_start = pending.start - pending.start % bucket
            if start <= case_start < end and case_start not in buckets:
                buckets[case_start] = (pending.temperature, pending.humidity)

        if pending_outdoor is not None and pending_outdoor.temperature is not None:
            case_start = pending_outdoor.start - pending_outdoor.start % bucket
            if start <= case_start < end and outdoor_buckets.get(case_start) is None:
                outdoor_buckets[case_start] = pending_outdoor.temperature

        temperatures, humidities = fill_grid(buckets, start, end, bucket)
        outdoor, _ = fill_grid(
            {case: (value, None) for case, value in outdoor_buckets.items()}, start, end, bucket
        )
        return {
            "room_id": area.id,
            "period": period,
            "start": _iso(start),
            "end": _iso(end),
            "bucket_seconds": bucket,
            "has_data": any(v is not None for v in temperatures + humidities),
            "temperature": temperatures,
            "humidity": humidities,
            "outdoor": outdoor,
            "regulation": [
                {
                    "at": _iso(at),
                    "target": state.target,
                    "heating": state.heating,
                    "status": state.status,
                    "reason": state.reason,
                }
                for at, state in regulation
            ],
        }

    def _pending_outdoor(self) -> MeasurementPoint | None:
        if self._outdoor_sampler is None or self._last_tick is None:
            return None
        return self._outdoor_sampler.close(self._last_tick + 60)

    def _pending_point(self, room_id: str) -> MeasurementPoint | None:
        sampler = self._samplers.get(room_id)
        if sampler is None or self._last_tick is None:
            return None
        return sampler.close(self._last_tick + 60)
