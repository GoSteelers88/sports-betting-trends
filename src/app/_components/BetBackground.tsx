"use client";

import { useEffect, useRef } from "react";

// Layered "video texture" background for kinetic bet sections.
// Two layers stack absolute-fill:
//   1. Canvas: rust-tinted crowd static (TV-noise simulation, rAF-driven)
//   2. CSS: perspective-warped turf pattern (animated parallax stripes)
//
// Both layers throttle to `pause` when the section leaves the viewport, via
// IntersectionObserver. Honors prefers-reduced-motion.

type League = "NBA" | "MLB" | "WNBA" | "NHL" | "DEFAULT";

const LEAGUE_HUE: Record<League, { warm: [number, number, number]; cool: [number, number, number] }> = {
  // [R, G, B] biases applied to the static — warm + cool channels
  MLB:     { warm: [1.0, 0.55, 0.15], cool: [0.25, 0.45, 0.20] }, // rust + grass
  NBA:     { warm: [1.0, 0.45, 0.15], cool: [0.35, 0.20, 0.10] }, // rust + court
  WNBA:    { warm: [1.0, 0.50, 0.20], cool: [0.40, 0.25, 0.15] },
  NHL:     { warm: [0.9,  0.55, 0.30], cool: [0.30, 0.40, 0.50] }, // rust + ice
  DEFAULT: { warm: [1.0, 0.50, 0.15], cool: [0.30, 0.30, 0.30] },
};

export function BetBackground({ league = "DEFAULT" }: { league?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const visibleRef = useRef(true);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    // Fixed low-res buffer scaled with CSS — cheap and looks more "broadcast"
    const W = 320;
    const H = 180;
    canvas.width = W;
    canvas.height = H;

    const palette = (LEAGUE_HUE[league as League] ?? LEAGUE_HUE.DEFAULT);
    const [wr, wg, wb] = palette.warm;
    const [cr, cg, cb] = palette.cool;

    const draw = () => {
      const img = ctx.createImageData(W, H);
      const data = img.data;
      for (let i = 0; i < data.length; i += 4) {
        const v = Math.random();
        // Threshold gate: most pixels stay dark, some pop bright
        const pop = v > 0.7 ? (v - 0.7) * 3.4 : 0; // 0..1
        const lvl = v < 0.5 ? v * 0.4 : pop;
        // Blend warm + cool tint by per-pixel coin flip — gives chromatic noise
        const warm = Math.random() < 0.5;
        const r = lvl * (warm ? wr : cr) * 255;
        const g = lvl * (warm ? wg : cg) * 255;
        const b = lvl * (warm ? wb : cb) * 255;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        // Sparse alpha — most pixels are transparent, the bright ones punch through
        data[i + 3] = v > 0.55 ? 220 * lvl : 0;
      }
      ctx.putImageData(img, 0, 0);

      // Horizontal banding sweep — fake TV roll
      const bandY = ((performance.now() / 12) % (H + 20)) - 10;
      ctx.fillStyle = "rgba(255, 106, 31, 0.06)";
      ctx.fillRect(0, bandY, W, 8);
    };

    let rafId = 0;
    let lastFrame = 0;
    const loop = (t: number) => {
      rafId = requestAnimationFrame(loop);
      if (!visibleRef.current) return;
      // ~24fps — gives that broadcast feel, saves CPU vs 60
      if (t - lastFrame < 42) return;
      lastFrame = t;
      draw();
    };

    if (reduceMotion) {
      draw(); // one static frame
    } else {
      rafId = requestAnimationFrame(loop);
    }

    const io = new IntersectionObserver(
      entries => {
        for (const e of entries) {
          visibleRef.current = e.isIntersecting;
        }
      },
      { threshold: 0.05 }
    );
    io.observe(wrap);

    return () => {
      cancelAnimationFrame(rafId);
      io.disconnect();
    };
  }, [league]);

  return (
    <div ref={wrapRef} className="absolute inset-0 pointer-events-none overflow-hidden">
      {/* Layer 1 — animated turf perspective grid */}
      <div className="absolute inset-0 turf-perspective" aria-hidden="true" />

      {/* Layer 2 — crowd static canvas */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{
          imageRendering: "pixelated",
          mixBlendMode: "screen",
          opacity: 0.35,
        }}
        aria-hidden="true"
      />

      {/* Layer 3 — vertical drift gradient (depth bias) */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(0,0,0,0.55) 0%, transparent 30%, transparent 70%, rgba(0,0,0,0.55) 100%)",
        }}
        aria-hidden="true"
      />
    </div>
  );
}
