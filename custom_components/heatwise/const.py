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
# Attente des capteurs après le rechargement de ZHA qui répare une sonde
# appairée sans capteurs (research R4ter).
PAIRING_RELOAD_ENTITIES_TIMEOUT = timedelta(seconds=30)

# --- Régulation automatique (spec 008) ---
# Événement émis quand l'état de régulation d'une ou plusieurs pièces
# change, avec `{"room_ids": [...]}` (research R8).
EVENT_REGULATION_UPDATED = "heatwise_regulation_updated"
# Signal dispatcher interne émis après ajout ou suppression d'un
# radiateur : la régulation réévalue toutes les pièces (research R4).
SIGNAL_RADIATORS_CHANGED = "heatwise_radiators_changed"
# Réévaluation au moins chaque minute à défaut d'événement (FR-007).
REGULATION_TICK = timedelta(seconds=60)
# Renvoi de l'ordre courant, bien en dessous de la coupure matérielle
# d'1 h du récepteur X2D (FR-013, research R5).
REGULATION_RESEND = timedelta(minutes=15)
# Suspension de la régulation d'une pièce après une action manuelle
# (FR-015, research R6).
MANUAL_SUSPENSION = timedelta(hours=1)
