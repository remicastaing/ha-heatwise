"""Constantes partagées du plugin Heatwise."""
from __future__ import annotations

from datetime import timedelta

DOMAIN = "heatwise"

# Événement émis après toute modification de la programmation ou des
# paramètres généraux (spec 005), avec `{"room_ids": [...] | None}`
# (`None` = modification concernant toute la maison). Cf.
# `specs/005-heatwise-calendrier/research.md` R7.
EVENT_SCHEDULE_UPDATED = "heatwise_schedule_updated"

# --- Appairage d'une sonde Zigbee (spec 007) ---
# ZHA est facultatif : Heatwise n'importe rien de
# `homeassistant.components.zha` et n'appelle que ce qui suit
# (cf. specs/007-heatwise-appairage-sonde/research.md R2, R3).
ZHA_DOMAIN = "zha"
ZHA_SERVICE_PERMIT = "permit"
# Signal dispatcher interne de ZHA (`ZHA_GW_MSG`), non garanti stable :
# celui que relaie la commande `zha/devices/permit` au frontend (R3).
ZHA_GW_MSG_SIGNAL = "zha_gateway_message"
ZHA_MSG_DEVICE_JOINED = "device_joined"
ZHA_MSG_DEVICE_FULLY_INITIALIZED = "device_fully_initialized"
# Cluster Zigbee « Temperature Measurement », lu dans la signature de
# l'appareil pour distinguer une non-sonde d'une sonde dont ZHA n'a pas
# créé les entités (research R4bis).
ZHA_TEMPERATURE_CLUSTER = 0x0402

# Délais de la session d'appairage (R5).
PAIRING_DURATION = timedelta(seconds=180)
PAIRING_CONFIG_TIMEOUT = timedelta(seconds=120)
PAIRING_ENTITIES_TIMEOUT = timedelta(seconds=10)
PAIRING_SETTLE_DELAY = timedelta(seconds=2)
