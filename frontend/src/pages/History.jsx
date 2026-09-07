// frontend/src/pages/History.jsx
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Loader2, LockKeyhole } from "lucide-react";
import api from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";
import { Link } from "react-router-dom";
import { Button } from "../components/ui/button.jsx";
import HistoryTable from "../components/HistoryTable.jsx";

export default function History() {
  const { isAuthenticated, loading: authLoading } = useAuth();
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading || !isAuthenticated) {
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    api
      .get("/history?limit=100")
      .then(({ data }) => setRows(data))
      .catch(() => setError("Could not load history"))
      .finally(() => setLoading(false));
  }, [authLoading, isAuthenticated, t]);

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1.5">
        <span className="font-mono text-xs uppercase tracking-[0.2em] text-signal/80">{"Voyage log"}</span>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-paper-50 sm:text-3xl">
          {"Forecast history"}
        </h1>
      </header>

      {!authLoading && !isAuthenticated && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-hull-600/70 bg-hull-900/60 px-6 py-16 text-center"
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-signal/20 bg-signal/10 text-signal">
            <LockKeyhole className="h-6 w-6" />
          </span>
          <div>
            <h2 className="font-display text-xl font-semibold text-paper-50">Sign in to view your forecast history</h2>
            <p className="mt-1 max-w-md text-sm text-slate-400">Forecasting stays public. Your saved forecasts and reports are private to your account.</p>
          </div>
          <Link to="/login">
            <Button>Sign in to continue</Button>
          </Link>
        </motion.div>
      )}

      {isAuthenticated && loading && (
        <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin text-signal" />
          <span className="text-sm">{"Loading history…"}</span>
        </div>
      )}

      {isAuthenticated && error && (
        <div className="flex items-center gap-2 rounded-lg border border-port/30 bg-port/10 px-4 py-2.5 text-sm font-medium text-port">
          <AlertTriangle className="h-3.5 w-3.5" /> {error}
        </div>
      )}

      {isAuthenticated && !loading && !error && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
          <HistoryTable rows={rows} />
        </motion.div>
      )}
    </section>
  );
}
