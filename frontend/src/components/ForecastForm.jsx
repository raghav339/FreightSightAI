import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Compass, Loader2, RotateCw, WifiOff } from "lucide-react";
import api from "../api/client.js";
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
        setMetaError("Could not load route options. Is the ML service running?");
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
      setError("Total program tonnage can't be less than the cargo weight per lift.");
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
        setError("You're offline and no cached forecast exists yet for this route, commodity and cargo weight.");
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
      setError(
        err.response?.data?.error ||
        (Array.isArray(err.response?.data?.details) ? err.response.data.details.join(", ") : null) ||
        (isNetworkFailure
          ? "Could not reach the forecasting service, and no cached forecast exists yet for this route."
          : "Forecast request failed. Is the ML service running?")
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
        <div className="fs-kicker">Shipment details</div>
      </div>

      <div className="shipment-sheet__grid">
        <Field label="Commodity">
          <Select required value={form.commodity} onChange={(e) => update("commodity", e.target.value)}>
            <option value="">Select commodity</option>
            {meta.commodities.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </Field>
        <Field label="Origin port">
          <Select required value={form.origin_port} onChange={(e) => update("origin_port", e.target.value)}>
            <option value="">Select origin</option>
            {meta.origins.map((o) => <option key={o} value={o}>{o}</option>)}
          </Select>
        </Field>
        <Field label="Destination port">
          <Select required value={form.destination_port} onChange={(e) => update("destination_port", e.target.value)}>
            <option value="">Select destination</option>
            {meta.destinations.map((d) => <option key={d} value={d}>{d}</option>)}
          </Select>
        </Field>
        <Field label="Shipment date">
          <Input type="date" required value={form.shipment_date} onChange={(e) => update("shipment_date", e.target.value)} />
        </Field>

        <Field label="Cargo weight" hint="tonnes">
          <Input type="number" min="1" step="0.1" required placeholder="Enter weight" value={form.cargo_weight_tons} onChange={(e) => update("cargo_weight_tons", e.target.value)} />
        </Field>
        <Field label="Shipment mode">
          <Select value={form.shipment_mode} onChange={(e) => update("shipment_mode", e.target.value)}>
            <option value="">Select mode</option>
            {meta.shipment_modes.map((m) => <option key={m} value={m}>{m}</option>)}
          </Select>
        </Field>
        <Field label="Vessel class">
          <Select value={form.vessel_type} onChange={(e) => update("vessel_type", e.target.value)}>
            <option value="">Auto-recommend</option>
            {vesselTypes.map((v) => <option key={v} value={v}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Contract duration" hint="months · COA">
          <Input type="number" min="0" step="1" placeholder="single voyage" value={form.contract_duration_months} onChange={(e) => update("contract_duration_months", e.target.value)} />
        </Field>
      </div>

      <details className="shipment-sheet__advanced">
        <summary>Additional planning inputs</summary>
        <div className="shipment-sheet__advanced-grid">
          <Field label="Cargo volume" hint="optional · cbm"><Input type="number" min="0" step="0.1" value={form.cargo_volume_cbm} onChange={(e) => update("cargo_volume_cbm", e.target.value)} /></Field>
          <Field label="Distance" hint="optional · km"><Input type="number" min="0" step="1" value={form.distance_km} onChange={(e) => update("distance_km", e.target.value)} /></Field>
          <Field label="Expected delay" hint="optional · days"><Input type="number" min="0" step="0.1" value={form.delay_days} onChange={(e) => update("delay_days", e.target.value)} /></Field>
          <Field label="Total program tonnage" hint="optional · COA" error={totalTonsInvalid ? `Must be at least ${form.cargo_weight_tons} tons.` : null}><Input type="number" min={form.cargo_weight_tons || 0} step="100" value={form.total_program_tons} onChange={(e) => update("total_program_tons", e.target.value)} /></Field>
        </div>
      </details>

      {metaLoading && !metaError && (
        <div className="shipment-sheet__service-note"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting to the forecasting service…</div>
      )}
      {metaOffline && !metaError && (
        <div className="shipment-sheet__service-note">
          <WifiOff className="h-3.5 w-3.5" />
          <span>Offline — using the route list saved from your last connected session. Submitting will look up a cached forecast for this route.</span>
        </div>
      )}
      {metaError && (
        <div className="shipment-sheet__service-note shipment-sheet__service-note--warn">
          <AlertTriangle className="h-3.5 w-3.5" />
          <span>{metaError}</span>
          <button type="button" className="ml-auto inline-flex items-center gap-1 underline decoration-dotted underline-offset-2" onClick={() => setRetryToken((t) => t + 1)}>
            <RotateCw className="h-3 w-3" /> Retry
          </button>
        </div>
      )}

      <div className="shipment-sheet__bottom">
        <p className="shipment-sheet__hint">
          Add a contract duration if you are planning a short/mid-term Contract of Affreightment across multiple voyages instead of a one-off spot fixture.
        </p>
        {error && <div className="shipment-sheet__error"><AlertTriangle className="h-3.5 w-3.5" /> {error}</div>}
        <Button type="submit" disabled={loading} className="shipment-sheet__submit">
          <Compass className="h-3.5 w-3.5" /> {loading ? "Run forecast…" : "Run forecast"}
        </Button>
      </div>
    </motion.form>
  );
}
