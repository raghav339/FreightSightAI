// frontend/src/components/ForecastForm.jsx
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Loader2, AlertTriangle, RotateCw, Compass } from "lucide-react";
import api from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card.jsx";
import { Field, Input, Select } from "./ui/field.jsx";
import { Button } from "./ui/button.jsx";

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
  // Objective: plan short/mid-term multi-voyage (COA) contracts, not just one-off spot fixtures
  contract_duration_months: "",
  total_program_tons: "",
};

const MAX_META_RETRIES = 5;
const META_RETRY_BASE_MS = 1500; // 1.5s, 3s, 4.5s, 6s, 7.5s

export default function ForecastForm({ onResult }) {
  const [meta, setMeta] = useState({ commodities: ["Coal", "Iron Ore", "Bulk Minerals & Ores"], origins: [], destinations: [], shipment_modes: [] });
  const [vesselTypes, setVesselTypes] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [metaError, setMetaError] = useState(null);
  const [metaLoading, setMetaLoading] = useState(true);
  const [retryToken, setRetryToken] = useState(0); // bump to trigger a manual retry

  useEffect(() => {
    let cancelled = false;

    async function loadMeta() {
      setMetaLoading(true);
      setMetaError(null);

      for (let attempt = 1; attempt <= MAX_META_RETRIES; attempt++) {
        try {
          const { data } = await api.get("/routes");
          if (cancelled) return;
          setMeta(data);
          setMetaError(null);
          setMetaLoading(false);

          // Vessel types are optional — fetch best-effort, don't block on it.
          api
            .get("/vessels")
            .then(({ data: vData }) => {
              if (!cancelled) setVesselTypes(vData.vessel_types || []);
            })
            .catch(() => {});
          return;
        } catch (err) {
          if (cancelled) return;
          const isLastAttempt = attempt === MAX_META_RETRIES;
          if (isLastAttempt) {
            setMetaError("Could not load route options. Is the ML service running?");
            setMetaLoading(false);
            return;
          }
          // Likely the ML service is still starting up / loading its model
          // for the first time — wait a bit longer each try, then retry.
          await new Promise((resolve) => setTimeout(resolve, META_RETRY_BASE_MS * attempt));
        }
      }
    }

    loadMeta();
    return () => {
      cancelled = true;
    };
  }, [retryToken]);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    if (
      form.total_program_tons &&
      Number(form.total_program_tons) < Number(form.cargo_weight_tons)
    ) {
      setError("Total program tonnage can't be less than the cargo weight per lift.");
      return;
    }

    setLoading(true);
    try {
      const payload = {
        ...form,
        shipment_date: form.shipment_date,
        cargo_weight_tons: Number(form.cargo_weight_tons),
        cargo_volume_cbm: form.cargo_volume_cbm ? Number(form.cargo_volume_cbm) : undefined,
        distance_km: form.distance_km ? Number(form.distance_km) : undefined,
        delay_days: form.delay_days ? Number(form.delay_days) : 0,
        vessel_type: form.vessel_type || undefined,
        contract_duration_months: form.contract_duration_months ? Number(form.contract_duration_months) : undefined,
        total_program_tons: form.total_program_tons ? Number(form.total_program_tons) : undefined,
      };
      const { data } = await api.post("/forecast", payload);
      onResult(data, payload);
    } catch (err) {
      setError(
        err.response?.data?.error ||
        (Array.isArray(err.response?.data?.details)
          ? err.response.data.details.join(", ")
          : null) ||
        "Forecast request failed. Is the ML service running?"
      );
    } finally {
      setLoading(false);
    }
  }

  const totalTonsInvalid =
    form.total_program_tons && Number(form.total_program_tons) < Number(form.cargo_weight_tons);

  return (
    <motion.form
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      onSubmit={handleSubmit}
    >
      <Card>
        <CardHeader className="flex flex-row items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-signal/10 text-signal">
            <Compass className="h-[18px] w-[18px]" />
          </span>
          <CardTitle className="text-lg">{"Shipment details"}</CardTitle>
        </CardHeader>

        <CardContent className="flex flex-col gap-6 pt-2">
          {metaLoading && !metaError && (
            <div className="flex items-center gap-2 rounded-lg border border-amber/25 bg-amber/10 px-4 py-2.5 text-sm font-medium text-amber">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {"Connecting to the forecasting service…"}
            </div>
          )}
          {metaError && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber/25 bg-amber/10 px-4 py-2.5 text-sm font-medium text-amber">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {metaError}
              <button
                type="button"
                className="ml-auto inline-flex items-center gap-1 font-semibold underline decoration-dotted underline-offset-2"
                onClick={() => setRetryToken((t) => t + 1)}
              >
                <RotateCw className="h-3 w-3" /> {"Retry"}
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={"Commodity"}>
              <Select required value={form.commodity} onChange={(e) => update("commodity", e.target.value)}>
                <option value="">{"Select commodity"}</option>
                {meta.commodities.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>

            <Field label={"Origin port"}>
              <Select required value={form.origin_port} onChange={(e) => update("origin_port", e.target.value)}>
                <option value="">{"Select origin"}</option>
                {meta.origins.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </Select>
            </Field>

            <Field label={"Destination port"}>
              <Select required value={form.destination_port} onChange={(e) => update("destination_port", e.target.value)}>
                <option value="">{"Select destination"}</option>
                {meta.destinations.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </Select>
            </Field>

            <Field label={"Shipment date"}>
              <Input
                type="date"
                required
                value={form.shipment_date}
                onChange={(e) => update("shipment_date", e.target.value)}
              />
            </Field>

            <Field label={"Cargo weight (tons)"}>
              <Input
                type="number"
                min="1"
                step="0.1"
                required
                value={form.cargo_weight_tons}
                onChange={(e) => update("cargo_weight_tons", e.target.value)}
              />
            </Field>

            <Field label={"Cargo volume (cbm)"} hint={"optional"}>
              <Input
                type="number"
                min="0"
                step="0.1"
                value={form.cargo_volume_cbm}
                onChange={(e) => update("cargo_volume_cbm", e.target.value)}
              />
            </Field>

            <Field label={"Shipment mode"} hint={"advanced"}>
              <Select value={form.shipment_mode} onChange={(e) => update("shipment_mode", e.target.value)}>
                <option value="">{"Select mode"}</option>
                {meta.shipment_modes.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </Select>
            </Field>

            <Field label={"Vessel type"} hint={"optional"}>
              <Select value={form.vessel_type} onChange={(e) => update("vessel_type", e.target.value)}>
                <option value="">{"Auto-recommend"}</option>
                {vesselTypes.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </Select>
            </Field>

            <Field label={"Distance (km)"} hint={"optional"}>
              <Input
                type="number"
                min="0"
                step="1"
                value={form.distance_km}
                onChange={(e) => update("distance_km", e.target.value)}
              />
            </Field>

            <Field label={"Expected delay (days)"} hint={"optional"}>
              <Input
                type="number"
                min="0"
                step="0.1"
                value={form.delay_days}
                onChange={(e) => update("delay_days", e.target.value)}
              />
            </Field>

            <Field label={"Contract duration (months)"} hint={"optional — COA planning"}>
              <Input
                type="number"
                min="0"
                step="1"
                value={form.contract_duration_months}
                onChange={(e) => update("contract_duration_months", e.target.value)}
              />
            </Field>

            <Field
              label={"Total program tonnage"}
              hint={"optional — COA planning"}
              error={
                totalTonsInvalid
                  ? `Total program tonnage must be at least ${form.cargo_weight_tons} tons.`
                  : null
              }
            >
              <Input
                type="number"
                min={form.cargo_weight_tons || 0}
                step="100"
                value={form.total_program_tons}
                onChange={(e) => update("total_program_tons", e.target.value)}
              />
            </Field>
          </div>

          <p className="rounded-lg border border-hull-600/60 bg-hull-900/50 px-4 py-3 text-xs leading-relaxed text-slate-500">
            {"Add a contract duration and total program tonnage if you're planning a short/mid-term Contract of Affreightment (COA) across multiple voyages instead of a one-off spot fixture."}
          </p>

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-port/30 bg-port/10 px-4 py-2.5 text-sm font-medium text-port">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {error}
            </div>
          )}

          <Button type="submit" disabled={loading} className="w-full sm:w-auto">
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> {"Predicting…"}
              </>
            ) : (
              "Predict"
            )}
          </Button>
        </CardContent>
      </Card>
    </motion.form>
  );
}