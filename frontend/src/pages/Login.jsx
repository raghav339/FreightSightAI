// frontend/src/pages/Login.jsx
import { useState } from "react";
import { motion } from "framer-motion";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { LogIn, AlertTriangle, Loader2, Anchor } from "lucide-react";
import { useAuth } from "../context/AuthContext.jsx";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Field, Input } from "../components/ui/field.jsx";
import { Button } from "../components/ui/button.jsx";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const redirectTo = location.state?.from || "/predict";

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(form);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || "Login failed. Check your email and password.");
    } finally {
      setLoading(false);
    }
  }


  return (
    <section className="mx-auto flex max-w-md flex-col gap-8">
      <header className="flex flex-col items-center gap-2 text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-signal/30 bg-signal/10 text-signal">
          <Anchor className="h-5 w-5" strokeWidth={2.25} />
        </span>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-paper-50">{"Welcome back"}</h1>
        <p className="text-sm text-slate-400">{"Sign in to run forecasts and manage your chartering data."}</p>
      </header>

      <motion.form
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        onSubmit={handleSubmit}
      >
        <Card>
          <CardHeader className="flex flex-row items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-signal/10 text-signal">
              <LogIn className="h-[18px] w-[18px]" />
            </span>
            <CardTitle className="text-lg">{"Log in"}</CardTitle>
          </CardHeader>

          <CardContent className="flex flex-col gap-5 pt-2">

            <Field label={"Email"}>
              <Input
                type="email"
                required
                autoComplete="email"
                value={form.email}
                onChange={(e) => update("email", e.target.value)}
              />
            </Field>

            <Field label={"Password"}>
              <Input
                type="password"
                required
                autoComplete="current-password"
                value={form.password}
                onChange={(e) => update("password", e.target.value)}
              />
            </Field>

            {error && (
              <div className="flex items-center gap-2 rounded-lg border border-port/30 bg-port/10 px-4 py-2.5 text-sm font-medium text-port">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {error}
              </div>
            )}

            <Button type="submit" disabled={loading} className="w-full">
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> {"Signing in…"}
                </>
              ) : (
                "Log in"
              )}
            </Button>

            <p className="text-center text-sm text-slate-400">
              {"Don't have an account?"}{" "}
              <Link to="/signup" className="font-medium text-signal hover:underline">
                {"Sign up"}
              </Link>
            </p>
          </CardContent>
        </Card>
      </motion.form>
    </section>
  );
}
