// Resilience mode — connection-quality detection.
//
// Ports, ship agents, and field procurement teams are exactly the kind of
// users who hit patchy satellite/mobile links, not just a flaky office
// wifi — so this isn't a cosmetic feature, it's tracking the network
// condition the app actually expects to run in.
//
// navigator.connection (Network Information API) is Chromium-only today
// (not in Safari/Firefox), so this degrades gracefully: without it we
// still catch the online/offline transition via the standard browser
// events, we just can't tell "slow" from "fine" while nominally online.
import { useEffect, useState } from "react";

function readConnection() {
  const conn =
    typeof navigator !== "undefined" &&
    (navigator.connection || navigator.mozConnection || navigator.webkitConnection);
  if (!conn) return { effectiveType: null, downlinkMbps: null, saveData: false, supported: false };
  return {
    effectiveType: conn.effectiveType || null, // "slow-2g" | "2g" | "3g" | "4g"
    downlinkMbps: typeof conn.downlink === "number" ? conn.downlink : null,
    saveData: !!conn.saveData,
    supported: true,
  };
}

function computeIsSlow(online, connection) {
  if (!online) return true;
  if (connection.saveData) return true;
  if (connection.effectiveType === "slow-2g" || connection.effectiveType === "2g") return true;
  if (connection.downlinkMbps != null && connection.downlinkMbps < 0.6) return true;
  return false;
}

export default function useNetworkStatus() {
  const [online, setOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const [connection, setConnection] = useState(readConnection);

  useEffect(() => {
    function handleOnline() { setOnline(true); }
    function handleOffline() { setOnline(false); }
    function handleConnectionChange() { setConnection(readConnection()); }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn && conn.addEventListener) conn.addEventListener("change", handleConnectionChange);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      if (conn && conn.removeEventListener) conn.removeEventListener("change", handleConnectionChange);
    };
  }, []);

  const isSlow = computeIsSlow(online, connection);

  return {
    online,
    effectiveType: connection.effectiveType,
    downlinkMbps: connection.downlinkMbps,
    saveData: connection.saveData,
    connectionApiSupported: connection.supported,
    // true when offline OR the browser reports a genuinely slow/metered link
    isSlow,
    // convenience label for banners
    status: !online ? "offline" : isSlow ? "slow" : "online",
  };
}
