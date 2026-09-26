// One-click Disruption Decision Brief: downloads a single page that closes
// the loop between the forecast, the Port Substitution Engine and the
// Disruption Engine — "cyclone hits Paradip" becomes one forwardable PDF
// with the propagation chain, the wait-vs-divert call, and the recommended
// alternative port. The server recomputes everything from the scenario
// (mode + event/port/severity + lane), so this just resends the form.
import { useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import api from "../api/client.js";
import { Button } from "./ui/button.jsx";

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
  return "Could not generate the disruption decision brief. Please try again.";
}

function slug(s) {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "brief";
}

export default function DisruptionBriefButton({ payload, disabledReason, className = "" }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const ready = payload && payload.port && (payload.mode === "live" || (payload.event_type && payload.severity !== undefined));

  async function download() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.post("/disruption/decision-brief", payload, { responseType: "blob" });
      const url = URL.createObjectURL(response.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `freightsight-disruption-brief-${slug(payload.port)}-${slug(payload.event_type || "live")}.pdf`;
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
        disabled={busy || !ready}
        title={ready ? undefined : disabledReason || "Run a simulation first."}
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
