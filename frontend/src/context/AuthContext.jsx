// frontend/src/context/AuthContext.jsx
// Holds the signed-in user + JWT in localStorage so refreshes keep the session.
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import api from "../api/client.js";

const AuthContext = createContext(null);
const TOKEN_KEY = "freightsight_token";

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [loading, setLoading] = useState(true);

  const persistToken = useCallback((nextToken) => {
    if (nextToken) localStorage.setItem(TOKEN_KEY, nextToken);
    else localStorage.removeItem(TOKEN_KEY);
    setToken(nextToken);
  }, []);

  // Restore the session on load / whenever the token changes.
  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    api
      .get("/auth/me")
      .then(({ data }) => {
        if (!cancelled) setUser(data.user);
      })
      .catch(() => {
        if (!cancelled) {
          persistToken(null);
          setUser(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, persistToken]);

  async function register({ name, email, password }) {
    const { data } = await api.post("/auth/register", { name, email, password });
    setUser(data.user);
    persistToken(data.token);
    return data;
  }

  async function login({ email, password }) {
    const { data } = await api.post("/auth/login", { email, password });
    setUser(data.user);
    persistToken(data.token);
    return data;
  }




  function logout() {
    setUser(null);
    persistToken(null);
  }

  const value = {
    user,
    token,
    loading,
    isAuthenticated: !!user,
    isVerified: !!user?.is_verified,
    register,
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}

export { TOKEN_KEY };
