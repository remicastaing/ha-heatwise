"""Décision de régulation d'une pièce (spec 008) — module pur.

Aucun import Home Assistant : la décision se teste avec des instants
arbitraires, sans `hass` (principe IV). C'est le **seul** endroit à
modifier pour changer l'algorithme de pilotage (anticipation,
température extérieure, inertie de la pièce…) : voir
`specs/008-heatwise-regulation-auto/contracts/regulation-policy.md`.

- `RoomInputs` : tout ce qu'une politique peut lire. Une entrée future
  s'ajoute comme champ optionnel valant `None` par défaut.
- `RegulationPolicy` : l'algorithme, `decide(inputs) -> Decision`.
- `decide(inputs, policy)` : applique d'abord les garde-fous sonde
  (principe I), puis seulement délègue à la politique, qui ne voit donc
  jamais une mesure absente, invalide ou périmée.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Protocol


class SensorHealth(StrEnum):
    """État de la sonde de la pièce (data-model.md)."""

    OK = "ok"
    NONE = "none"  # pas de sonde associée à la pièce
    MISSING = "missing"  # entité configurée mais sans état
    UNAVAILABLE = "unavailable"  # unavailable / unknown
    INVALID = "invalid"  # état non numérique
    STALE = "stale"  # plus d'1 h sans mesure (sensors.is_stale)


class Reason(StrEnum):
    BELOW_TARGET = "below_target"
    TARGET_REACHED = "target_reached"
    HYSTERESIS_HOLD = "hysteresis_hold"
    NO_SENSOR = "no_sensor"
    SENSOR_UNAVAILABLE = "sensor_unavailable"
    SENSOR_STALE = "sensor_stale"


@dataclass(frozen=True)
class Decision:
    heating: bool
    reason: Reason


# État « précédent » au démarrage et après un arrêt de sécurité (FR-005).
OFF = Decision(False, Reason.HYSTERESIS_HOLD)


@dataclass(frozen=True)
class RoomInputs:
    now: datetime
    room_id: str
    target: float
    measured: float | None
    sensor: SensorHealth
    previous: Decision = OFF


class RegulationPolicy(Protocol):
    def decide(self, inputs: RoomInputs) -> Decision:
        """Décision pour une mesure numérique fraîche (`sensor == OK`)."""
        ...


DEFAULT_MARGIN = 0.3


@dataclass(frozen=True)
class HysteresisPolicy:
    """Hystérésis simple (FR-004) : chauffe sous `consigne − marge`,
    arrêt dès la consigne atteinte, état conservé entre les deux."""

    margin: float = DEFAULT_MARGIN

    def decide(self, inputs: RoomInputs) -> Decision:
        assert inputs.measured is not None
        # Arrondi au dixième : 19.7 doit valoir exactement 20 − 0.3.
        measured = round(inputs.measured, 1)
        if measured >= round(inputs.target, 1):
            return Decision(False, Reason.TARGET_REACHED)
        if measured < round(inputs.target - self.margin, 1):
            return Decision(True, Reason.BELOW_TARGET)
        return Decision(inputs.previous.heating, Reason.HYSTERESIS_HOLD)


_GUARDS: dict[SensorHealth, Reason] = {
    SensorHealth.NONE: Reason.NO_SENSOR,
    SensorHealth.MISSING: Reason.SENSOR_UNAVAILABLE,
    SensorHealth.UNAVAILABLE: Reason.SENSOR_UNAVAILABLE,
    SensorHealth.INVALID: Reason.SENSOR_UNAVAILABLE,
    SensorHealth.STALE: Reason.SENSOR_STALE,
}


def decide(inputs: RoomInputs, policy: RegulationPolicy) -> Decision:
    """Garde-fous (principe I, FR-008) puis politique."""
    if inputs.sensor != SensorHealth.OK or inputs.measured is None:
        return Decision(False, _GUARDS.get(inputs.sensor, Reason.SENSOR_UNAVAILABLE))
    return policy.decide(inputs)
