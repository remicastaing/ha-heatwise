"""Connexion série asynchrone au dongle RFPlayer.

Ce module s'occupe uniquement de l'E/S (connexion série via
`pyserial-asyncio`) ; l'encodage des commandes reste dans `x2d_protocol.py`
(pur, sans E/S, cf. `docs/rfplayer-x2d.md`). Le protocole X2D n'a aucun
accusé de réception : une écriture réussie prouve seulement que l'ordre a
été remis au dongle, pas que le radiateur l'a reçu — la confirmation reste
visuelle (voyants du récepteur), cf. `research.md` de la spec 003
(« Disponibilité du dongle »).
"""
from __future__ import annotations

import asyncio
import logging

import serial_asyncio

from . import x2d_protocol

_LOGGER = logging.getLogger(__name__)

BAUDRATE = 115200
IO_TIMEOUT = 5  # secondes


class RFPlayerUnreachable(Exception):
    """Levée quand une commande n'a pas pu être remise au dongle."""


class RFPlayerClient:
    """Connexion série asynchrone à un dongle RFPlayer.

    Se reconnecte paresseusement : `async_send` (ré)ouvre la connexion si
    besoin avant d'écrire. La construction et `async_connect()` ne lèvent
    jamais d'exception (le dongle peut être absent au démarrage de Home
    Assistant, cf. `research.md`) ; seule une commande qui échoue lève
    `RFPlayerUnreachable`.
    """

    def __init__(self, port: str) -> None:
        self._port = port
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None

    async def async_connect(self) -> None:
        """Tente d'ouvrir la connexion. Échec journalisé, jamais levé :
        la reconnexion sera retentée à la prochaine commande envoyée."""
        try:
            await self._async_ensure_open()
        except RFPlayerUnreachable:
            _LOGGER.warning("Dongle RFPlayer injoignable sur %s", self._port)

    async def async_close(self) -> None:
        writer, self._writer = self._writer, None
        self._reader = None
        if writer is not None:
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:  # pragma: no cover - fermeture best-effort
                pass

    async def _async_ensure_open(self) -> asyncio.StreamWriter:
        if self._writer is None or self._writer.is_closing():
            try:
                async with asyncio.timeout(IO_TIMEOUT):
                    self._reader, self._writer = await serial_asyncio.open_serial_connection(
                        url=self._port, baudrate=BAUDRATE
                    )
            except (OSError, asyncio.TimeoutError) as err:
                self._reader = None
                self._writer = None
                raise RFPlayerUnreachable(str(err)) from err
        return self._writer

    async def async_send(self, command: str) -> None:
        """Envoie une commande brute (déjà préfixée `ZIA++`, cf.
        `x2d_protocol.py`) au dongle.

        Lève `RFPlayerUnreachable` si la connexion ne peut pas être
        (ré)ouverte ou si l'écriture échoue.
        """
        writer = await self._async_ensure_open()
        try:
            async with asyncio.timeout(IO_TIMEOUT):
                writer.write(f"{command}\r".encode())
                await writer.drain()
        except (OSError, asyncio.TimeoutError) as err:
            await self.async_close()
            raise RFPlayerUnreachable(str(err)) from err

    async def async_pair(self, transmitter_id: int) -> None:
        """Associe le dongle (voie TH) au radiateur portant cette identité
        radio (FR-005)."""
        await self.async_send(x2d_protocol.encode_assoc(transmitter_id))

    async def async_unpair(self, transmitter_id: int) -> None:
        """Dissocie le radiateur (abandon d'un appairage, FR-012)."""
        await self.async_send(x2d_protocol.encode_dissoc(transmitter_id))

    async def async_set_heating(self, transmitter_id: int, *, heating: bool) -> None:
        """Envoie l'ordre de marche/arrêt de la chauffe (FR-017)."""
        await self.async_send(x2d_protocol.encode_heat_order(transmitter_id, heating=heating))
