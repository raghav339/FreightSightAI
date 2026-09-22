import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Compass, Loader2, RotateCw, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import api from "../api/client.js";
import { useLabels } from "../i18n/labels.js";
import { Field, Input, Select } from "./ui/field.jsx";
import { Button } from "./ui/button.jsx";
import useNetworkStatus from "../hooks/useNetworkStatus.js";
import {
  getClosestForecast,
  getExactForecast,
  getMeta,
  getVesselTypes,
  saveForecastResult,
  saveMeta,
  saveVesselTypes,
} from "../lib/forecastCache.js";

const EMPTY_FORM = {
  commodity: "",
  origin_port: "",
  destination_port: "",
  shipment_date: "",
  cargo_weight_tons: "",
  cargo_volume_cbm: "",
  shipment_mode: "Bulk Carrier",
  vessel_type: "",
  distance_km: "",
  delay_days: "",
  contract_duration_months: "",
  total_program_tons: "",
};

const MAX_META_RETRIES = 5;
const META_RETRY_BASE_MS = 1500;

export default function ForecastForm({ onResult }) {
  const { t, i18n } = useTranslation();
  const L = useLabels();
  const [meta, setMeta] = useState({
    commodities: ["Coal", "Iron Ore", "Bulk Minerals & Ores"],
    origins: [],
    destinations: [],
    shipment_modes: [],
  });
  const [vesselTypes, setVesselTypes] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [metaError, setMetaError] = useState(null);
  const [metaOffline, setMetaOffline] = useState(false);
  const [metaLoading, setMetaLoading] = useState(true);
  const [retryToken, setRetryToken] = useState(0);
  const { online } = useNetworkStatus();

  useEffect(() => {
    let cancelled = false;

    // Resilience mode: with no connection at all, don't burn the retry
    // loop dialing a service we already know is unreachable — go straight
    // to whatever route/vessel list was cached from the last time this
    // loaded successfully, so the form (and offline forecast lookup) still
    // works.
    function useOfflineMeta(errorIfNone) {
      const cachedMeta = getMeta();
      const cachedVessels = getVesselTypes();
      if (cachedMeta?.data) {
        setMeta(cachedMeta.data);
        setVesselTypes(cachedVessels?.data || []);
        setMetaOffline(true);
        setMetaError(null);
        setMetaLoading(false);
        return true;
      }
      if (errorIfNone) {
        setMetaError("form.errors.routeOptions");
        setMetaLoading(false);
      }
      return false;
    }

    async function loadMeta() {
      setMetaLoading(true);
      setMetaError(null);
      setMetaOffline(false);

      if (!navigator.onLine) {
        useOfflineMeta(true);
        return;
      }

      for (let attempt = 1; attempt <= MAX_META_RETRIES; attempt++) {
        try {
          const { data } = await api.get("/routes");
          if (cancelled) return;
          setMeta(data);
          saveMeta(data);
          setMetaLoading(false);
          api.get("/vessels").then(({ data: vData }) => {
            if (cancelled) return;
            const types = vData.vessel_types || [];
            setVesselTypes(types);
            saveVesselTypes(types);
          }).catch(() => {});
          return;
        } catch (err) {
          if (cancelled) return;
          if (attempt === MAX_META_RETRIES) {
            if (!useOfflineMeta(true)) return;
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, META_RETRY_BASE_MS * attempt));
        }
      }
    }
    loadMeta();
    return () => { cancelled = true; };
    // Re-run automatically when connectivity is restored (not just on
    // manual Retry), so coming back online upgrades cached meta to live
    // meta without the user having to notice and click anything.
  }, [retryToken, online]);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  // Resilience mode: serve a cached forecast instead of a hard failure
  // when we're offline or the live service is unreachable. An exact
  // route+commodity+cargo+date match is used as-is; otherwise the closest
  // cargo weight on the same lane is used and clearly labelled
  // approximate, so nobody mistakes a stand-in number for a fresh one.
  function tryCacheFallback(payload) {
    const exact = getExactForecast(payload);
    const entry = exact || getClosestForecast(payload);
    if (!entry) return false;
    onResult({ ...entry.result, _cached: true, _cachedAt: entry.savedAt, _approx: !exact }, payload);
    return true;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (form.total_program_tons && Number(form.total_program_tons) < Number(form.cargo_weight_tons)) {
      setError(t("form.errors.totalLessThanCargo"));
      return;
    }
    const payload = {
      ...form,
      cargo_weight_tons: Number(form.cargo_weight_tons),
      cargo_volume_cbm: form.cargo_volume_cbm ? Number(form.cargo_volume_cbm) : undefined,
      distance_km: form.distance_km ? Number(form.distance_km) : undefined,
      delay_days: form.delay_days ? Number(form.delay_days) : 0,
      vessel_type: form.vessel_type || undefined,
      contract_duration_months: form.contract_duration_months ? Number(form.contract_duration_months) : undefined,
      total_program_tons: form.total_program_tons ? Number(form.total_program_tons) : undefined,
    };

    if (!navigator.onLine) {
      if (!tryCacheFallback(payload)) {
        setError(t("form.errors.offlineNoCache"));
      }
      return;
    }

    setLoading(true);
    try {
      const { data } = await api.post("/forecast", payload);
      saveForecastResult(payload, data);
      onResult(data, payload);
    } catch (err) {
      const isNetworkFailure = !err.response;
      if (isNetworkFailure && tryCacheFallback(payload)) return;
      const serverCode = err.response?.data?.code;
      setError(
        (serverCode === "ml_starting" ? t("form.errors.mlStarting") : null) ||
        err.response?.data?.error ||
        (Array.isArray(err.response?.data?.details) ? err.response.data.details.join(", ") : null) ||
        (isNetworkFailure ? t("form.errors.unreachable") : t("form.errors.failed"))
      );
    } finally {
      setLoading(false);
    }
  }

  const totalTonsInvalid = form.total_program_tons && Number(form.total_program_tons) < Number(form.cargo_weight_tons);

  return (
    <motion.form
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      onSubmit={handleSubmit}
      className="shipment-sheet"
    >
      <div className="shipment-sheet__topline">
        <div className="fs-kicker">{t("form.shipmentDetails")}</div>
      </div>

      <div className="shipment-sheet__grid">
        <Field label={t("form.commodity")}>
          <Select required value={form.commodity} onChange={(e) => update("commodity", e.target.value)}>
            <option value="">{t("form.selectCommodity")}</option>
            {meta.commodities.map((c) => <option key={c} value={c}>{L.commodity(c)}</option>)}
          </Select>
        </Field>
        <Field label={t("form.originPort")}>
          <Select required value={form.origin_port} onChange={(e) => update("origin_port", e.target.value)}>
            <option value="">{t("form.selectOrigin")}</option>
            {meta.origins.map((o) => <option key={o} value={o}>{L.port(o)}</option>)}
          </Select>
        </Field>
        <Field label={t("form.destinationPort")}>
          <Select required value={form.destination_port} onChange={(e) => update("destination_port", e.target.value)}>
            <option value="">{t("form.selectDestination")}</option>
            {meta.destinations.map((d) => <option key={d} value={d}>{L.port(d)}</option>)}
          </Select>
        </Field>
        <Field label={t("form.shipmentDate")}>
          <Input type="date" lang={i18n.language} required value={form.shipment_date} onChange={(e) => update("shipment_date", e.target.value)} />
        </Field>

        <Field label={t("form.cargoWeight")} hint={t("form.cargoWeightHint")}>
          <Input type="number" min="1" step="0.1" required placeholder={t("form.cargoWeightPlaceholder")} value={form.cargo_weight_tons} onChange={(e) => update("cargo_weight_tons", e.target.value)} />
        </Field>
        <Field label={t("form.shipmentMode")}>
          <Select value={form.shipment_mode} onChange={(e) => update("shipment_mode", e.target.value)}>
            <option value="">{t("form.selectMode")}</option>
            {meta.shipment_modes.map((m) => <option key={m} value={m}>{L.mode(m)}</option>)}
          </Select>
        </Field>
        <Field label={t("form.vesselClass")}>
          <Select value={form.vessel_type} onChange={(e) => update("vessel_type", e.target.value)}>
            <option value="">{t("form.autoRecommend")}</option>
            {vesselTypes.map((v) => <option key={v} value={v}>{L.vessel(v)}</option>)}
          </Select>
        </Field>
        <Field label={t("form.contractDuration")} hint={t("form.contractDurationHint")}>
          <Input type="number" min="0" step="1" placeholder={t("form.singleVoyage")} value={form.contract_duration_months} onChange={(e) => update("contract_duration_months", e.target.value)} />
        </Field>
      </div>

      <details className="shipment-sheet__advanced">
        <summary>{t("form.additional")}</summary>
        <div className="shipment-sheet__advanced-grid">
          <Field label={t("form.cargoVolume")} hint={t("form.hintOptionalCbm")}><Input type="number" min="0" step="0.1" value={form.cargo_volume_cbm} onChange={(e) => update("cargo_volume_cbm", e.target.value)} /></Field>
          <Field label={t("form.distance")} hint={t("form.hintOptionalKm")}><Input type="number" min="0" step="1" value={form.distance_km} onChange={(e) => update("distance_km", e.target.value)} /></Field>
          <Field label={t("form.expectedDelay")} hint={t("form.hintOptionalDays")}><Input type="number" min="0" step="0.1" value={form.delay_days} onChange={(e) => update("delay_days", e.target.value)} /></Field>
          <Field label={t("form.totalProgram")} hint={t("form.hintOptionalCoa")} error={totalTonsInvalid ? t("form.totalMin", { tons: form.cargo_weight_tons }) : null}><Input type="number" min={form.cargo_weight_tons || 0} step="100" value={form.total_program_tons} onChange={(e) => update("total_program_tons", e.target.value)} /></Field>
        </div>
      </details>

      {metaLoading && !metaError && (
        <div className="shipment-sheet__service-note"><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("form.connecting")}</div>
      )}
      {metaOffline && !metaError && (
        <div className="shipment-sheet__service-note">
          <WifiOff className="h-3.5 w-3.5" />
          <span>{t("form.offlineNote")}</span>
        </div>
      )}
      {metaError && (
        <div className="shipment-sheet__service-note shipment-sheet__service-note--warn">
          <AlertTriangle className="h-3.5 w-3.5" />
          <span>{t(metaError)}</span>
          <button type="button" className="ml-auto inline-flex items-center gap-1 underline decoration-dotted underline-offset-2" onClick={() => setRetryToken((t) => t + 1)}>
            <RotateCw className="h-3 w-3" /> {t("common.retry")}
          </button>
        </div>
      )}

      <div className="shipment-sheet__bottom">
        <p className="shipment-sheet__hint">
          {t("form.hint")}
        </p>
        {error && <div className="shipment-sheet__error"><AlertTriangle className="h-3.5 w-3.5" /> {error}</div>}
        <Button type="submit" disabled={loading} className="shipment-sheet__submit">
          <Compass className="h-3.5 w-3.5" /> {loading ? t("form.submitting") : t("form.submit")}
        </Button>
      </div>
    </motion.form>
  );
}
