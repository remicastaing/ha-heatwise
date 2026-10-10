"""Appairage d'une sonde Zigbee depuis le panneau (spec 007).

Une `SensorPairingSession` ouvre le réseau Zigbee par le service public
`zha.permit`, suit les appareils qui rejoignent grâce au signal interne
`zha_gateway_message` de ZHA, attend les capteurs du premier appareil qui
mesure la température, puis l'associe à la pièce par
`sensors.async_set_room_sensor` (mécanisme de la spec 006). Toute fin de
session referme le réseau. Cf. specs/007-heatwise-appairage-sonde/
research.md R1-R6 et data-model.md.

ZHA reste facultatif : rien n'est importé de `homeassistant.components.zha`.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import logging
from typing import Any, Callable

from homeassistant.core import Context, Event, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.event import async_call_later, async_track_state_added_domain
from homeassistant.util import dt as dt_util

from . import rooms as rooms_module
from . import sensors as sensors_module
from .const import (
    PAIRING_CONFIG_TIMEOUT,
    PAIRING_DURATION,
    PAIRING_ENTITIES_TIMEOUT,
    PAIRING_SETTLE_DELAY,
    ZHA_DOMAIN,
    ZHA_GW_MSG_SIGNAL,
    ZHA_MSG_DEVICE_FULLY_INITIALIZED,
    ZHA_MSG_DEVICE_JOINED,
    ZHA_SERVICE_PERMIT,
    ZHA_TEMPERATURE_CLUSTER,
)

_LOGGER = logging.getLogger(__name__)

# Statuts d'un appareil rejoint (data-model.md).
_CONFIGURING = "configuring"
_WAITING_ENTITIES = "waiting_entities"
_SETTLING = "settling"
_NOT_A_SENSOR = "not_a_sensor"
_PENDING = (_CONFIGURING, _WAITING_ENTITIES, _SETTLING)


class PairingUnavailableError(Exception):
    """Le réseau Zigbee ne peut pas être ouvert (ZHA absent ou en erreur)."""


@callback
def pairing_available(hass: HomeAssistant) -> bool:
    """Vrai si ZHA est chargé et offre son service d'appairage (R2)."""
    return hass.services.has_service(ZHA_DOMAIN, ZHA_SERVICE_PERMIT)


@dataclass(frozen=True)
class _ZhaMessage:
    kind: str
    ieee: str
    name: str | None
    temperature_cluster: bool


def _cluster_id(value: Any) -> int | None:
    """Identifiant de cluster de la signature ZHA (`"0x0402"` ou entier)."""
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value, 16)
        except ValueError:
            return None
    return None


def _announces_temperature(info: dict[str, Any]) -> bool:
    """Vrai si la signature de l'appareil annonce le cluster température."""
    signature = info.get("signature")
    endpoints = signature.get("endpoints") if isinstance(signature, dict) else None
    if not isinstance(endpoints, dict):
        return False
    return any(
        _cluster_id(cluster) == ZHA_TEMPERATURE_CLUSTER
        for endpoint in endpoints.values()
        if isinstance(endpoint, dict)
        for cluster in endpoint.get("input_clusters") or ()
    )


def _parse_message(message: Any) -> _ZhaMessage | None:
    """Message ZHA utile décodé, sinon `None` (R3)."""
    if not isinstance(message, dict):
        return None
    kind = message.get("type")
    if kind not in (ZHA_MSG_DEVICE_JOINED, ZHA_MSG_DEVICE_FULLY_INITIALIZED):
        return None
    info = message.get("device_info")
    if not isinstance(info, dict) or not isinstance(info.get("ieee"), str):
        return None
    name = info.get("user_given_name") or info.get("name")
    return _ZhaMessage(
        kind=kind,
        ieee=info["ieee"],
        name=name if isinstance(name, str) else None,
        temperature_cluster=_announces_temperature(info),
    )


@dataclass
class JoinedDevice:
    """Appareil ayant rejoint pendant la session."""

    ieee: str
    status: str = _CONFIGURING
    name: str | None = None
    # La signature annonce un capteur de température (R4bis).
    temperature_cluster: bool = False


class SensorPairingSession:
    """Une ouverture du réseau Zigbee pour équiper une pièce d'une sonde.

    `send` reçoit les événements du contrat `heatwise/pair_sensor`. Après
    un événement final ou `async_stop()`, plus rien n'est émis ni associé.
    """

    def __init__(
        self,
        hass: HomeAssistant,
        room_id: str,
        send: Callable[[dict[str, Any]], None],
        context: Context | None = None,
    ) -> None:
        self.hass = hass
        self.room_id = room_id
        self._send = send
        self._context = context
        self._devices: dict[str, JoinedDevice] = {}
        self._unsubs: list[Callable[[], None]] = []
        self._ends_at: datetime | None = None
        self._open_expired = False
        self._opened = False
        self._closed = False
        self._associating = False
        self.done = False

    # --- Cycle de vie ---

    async def async_start(self) -> None:
        """Ouvre le réseau ; lève `PairingUnavailableError` sinon."""
        if not pairing_available(self.hass):
            raise PairingUnavailableError("l'intégration Zigbee (ZHA) n'est pas chargée")
        self._unsubs.append(
            async_dispatcher_connect(self.hass, ZHA_GW_MSG_SIGNAL, self._on_zha_message)
        )
        self._unsubs.append(
            async_track_state_added_domain(self.hass, "sensor", self._on_sensor_added)
        )
        self._ends_at = dt_util.utcnow() + PAIRING_DURATION
        try:
            await self._async_permit(int(PAIRING_DURATION.total_seconds()))
        except HomeAssistantError as err:
            self.done = True
            self._teardown()
            raise PairingUnavailableError(str(err) or err.__class__.__name__) from err
        self._opened = True
        if self.done:  # arrêtée pendant l'ouverture
            await self._async_close()
            return
        self._unsubs.append(
            async_call_later(self.hass, PAIRING_DURATION, self._on_open_expired)
        )

    @callback
    def emit_waiting(self) -> None:
        """Émet `waiting` (après le résultat de la commande, cf. contrat)."""
        assert self._ends_at is not None
        self._emit({"type": "waiting", "ends_at": self._ends_at.isoformat()})

    async def async_stop(self) -> None:
        """Arrête la session (idempotent) : plus d'écoute, réseau refermé."""
        self.done = True
        self._teardown()
        await self._async_close()

    @callback
    def _teardown(self) -> None:
        while self._unsubs:
            self._unsubs.pop()()

    async def _async_permit(self, duration: int) -> None:
        await self.hass.services.async_call(
            ZHA_DOMAIN,
            ZHA_SERVICE_PERMIT,
            {"duration": duration},
            blocking=True,
            context=self._context,
        )

    async def _async_close(self) -> None:
        if not self._opened or self._closed:
            return
        self._closed = True
        try:
            await self._async_permit(0)
        except HomeAssistantError as err:  # le réseau se refermera de lui-même
            _LOGGER.warning("Fermeture de l'appairage Zigbee impossible : %s", err)

    @callback
    def _emit(self, event: dict[str, Any]) -> None:
        if not self.done:
            self._send(event)

    @callback
    def _finish(self, event: dict[str, Any]) -> None:
        """Émet un événement final puis termine la session."""
        if self.done:
            return
        self._send(event)
        self.done = True
        self._teardown()
        self.hass.async_create_task(self._async_close())

    # --- Messages ZHA ---

    @callback
    def _on_zha_message(self, message: Any) -> None:
        if self.done:
            return
        parsed = _parse_message(message)
        if parsed is None:
            return
        kind, ieee = parsed.kind, parsed.ieee
        device = self._devices.get(ieee)
        if device is None:
            device = self._devices[ieee] = JoinedDevice(ieee)
            self._emit({"type": "detected", "ieee": ieee})
            self._unsubs.append(
                async_call_later(
                    self.hass, PAIRING_CONFIG_TIMEOUT, self._config_timeout_job(device)
                )
            )
        if kind == ZHA_MSG_DEVICE_FULLY_INITIALIZED and device.status == _CONFIGURING:
            device.name = parsed.name
            device.temperature_cluster = parsed.temperature_cluster
            device.status = _WAITING_ENTITIES
            self._unsubs.append(
                async_call_later(
                    self.hass, PAIRING_ENTITIES_TIMEOUT, self._entities_timeout_job(device)
                )
            )
            self._check_device(device)

    def _config_timeout_job(self, device: JoinedDevice) -> Callable[[datetime], None]:
        @callback
        def _fire(_now: datetime) -> None:
            if device.status == _CONFIGURING:
                self._finish({"type": "config_timeout", "ieee": device.ieee})

        return _fire

    def _entities_timeout_job(self, device: JoinedDevice) -> Callable[[datetime], None]:
        @callback
        def _fire(_now: datetime) -> None:
            if device.status == _WAITING_ENTITIES:
                device.status = _NOT_A_SENSOR
                self._on_not_a_sensor(device)

        return _fire

    # --- Capteurs de l'appareil (R4) ---

    def _device_sensors(self, ieee: str) -> tuple[str | None, str | None, str | None]:
        """`(device_id, température, humidité)` de l'appareil ZHA `ieee`."""
        devices = dr.async_get(self.hass).async_get_devices(identifiers={(ZHA_DOMAIN, ieee)})
        if not devices:
            return None, None, None
        device = devices[0]
        found: dict[str, list[str]] = {
            sensors_module.KIND_TEMPERATURE: [],
            sensors_module.KIND_HUMIDITY: [],
        }
        for entry in er.async_entries_for_device(er.async_get(self.hass), device.id):
            kind = sensors_module.sensor_kind(self.hass.states.get(entry.entity_id))
            if kind in found:
                found[kind].append(entry.entity_id)
        temperature = sorted(found[sensors_module.KIND_TEMPERATURE])
        humidity = sorted(found[sensors_module.KIND_HUMIDITY])
        return (
            device.id,
            temperature[0] if temperature else None,
            humidity[0] if humidity else None,
        )

    @callback
    def _on_sensor_added(self, _event: Event) -> None:
        for device in list(self._devices.values()):
            if device.status == _WAITING_ENTITIES:
                self._check_device(device)

    @callback
    def _check_device(self, device: JoinedDevice) -> None:
        if self.done or self._associating:
            return
        _, temperature, _ = self._device_sensors(device.ieee)
        if temperature is None:
            return
        device.status = _SETTLING
        self._associating = True
        self._unsubs.append(
            async_call_later(self.hass, PAIRING_SETTLE_DELAY, self._association_job(device))
        )

    def _association_job(self, device: JoinedDevice):
        async def _fire(_now: datetime) -> None:
            await self._async_associate(device)

        return _fire

    async def _async_associate(self, device: JoinedDevice) -> None:
        if self.done:
            return
        device_id, temperature, humidity = self._device_sensors(device.ieee)
        name = self._display_name(device, device_id)
        if temperature is None:  # entité retirée entre-temps
            device.status = _NOT_A_SENSOR
            self._associating = False
            self._on_not_a_sensor(device)
            return
        try:
            sensors_module.async_set_room_sensor(self.hass, self.room_id, temperature, humidity)
        except sensors_module.SENSOR_ERRORS as err:
            code, message = sensors_module.sensor_error(err)
            self._finish(
                {
                    "type": "association_failed",
                    "code": code,
                    "message": message,
                    "device_name": name,
                }
            )
            return
        others = [
            other.name or other.ieee
            for other in self._devices.values()
            if other is not device
        ]
        room = await rooms_module.async_get_room(self.hass, self.room_id)
        # Si l'abonné est parti pendant l'assemblage, `_finish` n'émet
        # rien : l'association, elle, est faite et reste valable.
        self._finish(
            {
                "type": "associated",
                "room": room,
                "device_name": name,
                "temperature_entity_id": temperature,
                "humidity_entity_id": humidity,
                "other_devices": others,
            }
        )

    def _display_name(self, device: JoinedDevice, device_id: str | None) -> str:
        if device_id is not None:
            entry = dr.async_get(self.hass).async_get(device_id)
            if entry is not None and (entry.name_by_user or entry.name):
                return entry.name_by_user or entry.name
        return device.name or device.ieee

    # --- Issues sans association (R6) ---

    @callback
    def _on_not_a_sensor(self, device: JoinedDevice) -> None:
        device_id, _, _ = self._device_sensors(device.ieee)
        event = self._not_a_sensor_event(device, device_id)
        if self._open_expired and not self._pending():
            self._finish({**event, "final": True})
        else:
            self._emit({**event, "final": False})

    def _pending(self) -> bool:
        return any(d.status in _PENDING for d in self._devices.values())

    @callback
    def _on_open_expired(self, _now: datetime) -> None:
        self._open_expired = True
        if self._pending():
            return  # on attend l'issue de l'appareil en configuration
        non_sensors = [d for d in self._devices.values() if d.status == _NOT_A_SENSOR]
        if not non_sensors:
            self._finish({"type": "timeout"})
            return
        last = non_sensors[-1]
        device_id, _, _ = self._device_sensors(last.ieee)
        self._finish({**self._not_a_sensor_event(last, device_id), "final": True})

    def _not_a_sensor_event(self, device: JoinedDevice, device_id: str | None) -> dict[str, Any]:
        """`entities_missing` : l'appareil annonce le cluster température mais
        ZHA n'a créé aucun capteur (initialisation interrompue par des
        annonces répétées ; un redémarrage de HA les crée, R4bis)."""
        return {
            "type": "not_a_sensor",
            "ieee": device.ieee,
            "device_name": self._display_name(device, device_id),
            "entities_missing": device.temperature_cluster,
        }
