// Display labels for values that travel to the API in English (ports, commodities,
// vessel classes, shipment modes, risk levels). The English value stays the identifier;
// only what the user reads is translated. Unknown values fall back to themselves.
import { useTranslation } from "react-i18next";

export function useLabels() {
  const { t } = useTranslation();
  const label = (group) => (value) => (value == null || value === "" ? value : t(`labels.${group}.${value}`, { defaultValue: String(value) }));
  return {
    port: label("ports"),
    commodity: label("commodities"),
    vessel: label("vessels"),
    mode: label("modes"),
    risk: label("risk"),
    // "Newcastle-Paradip" -> translated port names joined with an en dash
    route: (value) => (value ? String(value).split("-").map((p) => t(`labels.ports.${p.trim()}`, { defaultValue: p.trim() })).join("–") : value),
  };
}
