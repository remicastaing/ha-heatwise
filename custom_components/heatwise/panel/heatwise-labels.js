// Libellés partagés par le panneau et le graphique d'historique
// (spec 008, repris par la spec 010).

// « 14:32 » si c'est aujourd'hui, « le 09/10 à 14:32 » sinon.
export function formatMoment(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const time = date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) {
    return time;
  }
  const day = date.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
  return `le ${day} à ${time}`;
}

// Spec 008 : libellé de l'état de régulation d'une pièce (contrat
// websocket-api.md). `kind` choisit le style : heating, idle, alert.
export function regulationLabel(regulation) {
  const { status, reason, suspended_until: until } = regulation;
  switch (status) {
    case "heating":
      return { kind: "heating", icon: "mdi:fire", text: "Chauffe" };
    case "idle":
      return {
        kind: "idle",
        icon: "mdi:thermostat-auto",
        text: reason === "target_reached" ? "Consigne atteinte" : "Régulée",
      };
    case "safety_stop": {
      const why = {
        sensor_unavailable: "sonde indisponible",
        sensor_stale: "sonde muette",
        dongle_unreachable: "dongle injoignable",
      }[reason] || reason;
      return { kind: "alert", icon: "mdi:alert-outline", text: `Arrêt de sécurité : ${why}` };
    }
    case "suspended":
      return {
        kind: "idle",
        icon: "mdi:hand-back-right-outline",
        text: `Régulation suspendue (manuel)${until ? ` jusqu'à ${formatMoment(until)}` : ""}`,
      };
    case "not_regulated":
      return {
        kind: "idle",
        icon: "mdi:thermostat-off",
        text:
          reason === "rfplayer_not_configured"
            ? "Non régulée : dongle non configuré"
            : "Non régulée : pas de sonde",
      };
    case "no_radiator":
      // Historique uniquement (spec 010) : pièce sans radiateur.
      return { kind: "idle", icon: "mdi:radiator-off", text: "Sans radiateur" };
    default:
      return null;
  }
}
