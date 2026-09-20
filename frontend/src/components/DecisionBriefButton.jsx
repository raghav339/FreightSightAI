// One-click Decision Brief: downloads a single boardroom-ready PDF that
// combines the current forecast, the what-if scenario (cargo / contract
// length as last set on the sliders) and the decision-simulator comparison.
// The server recomputes the comparisons from the saved forecast, so this
// only sends the two scenario numbers — it works whether or not the user has
// pressed "Compare procurement options" first.
import { useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import api from "../api/client.js";
import { Button } from "./ui/button.jsx";

// With responseType "blob", axios delivers error bodies as Blobs too, so the
// server's JSON message has to be read out of one.
async function messageFrom(err) {
  const data = err?.response?.data;
  if (data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text());
      if (parsed?.error) return parsed.error;
    } catch {
      /* fall through to the generic message */
    }
  } else if (data?.error) {
    return data.error;
  }
  if (err?.code === "ECONNABORTED") return "The brief took too long to build. Please try again.";
  return "Could not generate the decision brief. Please try again.";
}

export default function DecisionBriefButton({ recordId, cargo, duration, className = "" }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function download() {
    if (!recordId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const params = {};
      if (cargo) params.cargo_weight_tons = cargo;
      if (duration != null) params.contract_duration_months = duration;
      const response = await api.get(`/forecast/${recordId}/decision-brief`, { params, responseType: "blob" });
      const url = URL.createObjectURL(response.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `freightsight-decision-brief-${recordId}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(await messageFrom(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`flex flex-col items-end gap-1 ${className}`}>
      <Button
        type="button"
        size="sm"
        onClick={download}
        disabled={busy || !recordId}
        title={recordId ? undefined : "Run a forecast first — the brief is built from a saved forecast."}
        className="gap-2"
      >
        {busy ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Building brief…
          </>
        ) : (
          <>
            <FileText className="h-3.5 w-3.5" /> Download decision brief
          </>
        )}
      </Button>
      {error && (
        <span role="alert" className="max-w-xs text-right text-xs text-port">
          {error}
        </span>
      )}
    </div>
  );
}
