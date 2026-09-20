import WakingBanner from "./WakingBanner.jsx";
import ConnectionBanner from "./ConnectionBanner.jsx";

// Single fixed anchor for both status pills so an ML cold-start banner and
// a dropped-connection banner stack instead of rendering on top of each
// other when both are true at once.
export default function StatusBanners() {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[4.55rem] z-[60] flex flex-col items-center gap-2 px-4 pt-3">
      <WakingBanner />
      <ConnectionBanner />
    </div>
  );
}
