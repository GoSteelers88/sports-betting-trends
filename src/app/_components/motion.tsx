"use client";

// Motion primitives for the Paper Trial. Server components compose these
// around static content; all animation is transform/opacity, runs once on
// scroll entry, and is fenced behind gsap.matchMedia() so reduced-motion
// users get the finished page instantly.
//
// SAFETY CONTRACT: every tween here uses `immediateRender: false`. Content
// server-renders fully visible and stays visible if a trigger never fires —
// GSAP may only animate things IN, never strand them hidden. (The previous
// build used default immediateRender, which set below-fold content to
// opacity:0 at hydration and left it invisible when ScrollTriggers missed.)

import { useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(ScrollTrigger, useGSAP);

/** Masked rise — the child slides up from behind a clip line, like a
 *  headline coming off the press. */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const el = ref.current;
      const inner = el?.firstElementChild as HTMLElement | null;
      if (!el || !inner) return;
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from(inner, {
          yPercent: 108,
          duration: 1.05,
          delay,
          ease: "expo.out",
          immediateRender: false, // visible until the trigger actually fires
          scrollTrigger: { trigger: el, start: "top 92%", once: true },
        });
      });
    },
    { scope: ref }
  );
  return (
    <div ref={ref} className={className} style={{ overflow: "hidden" }}>
      <div>{children}</div>
    </div>
  );
}

/** Stamp slam — the wrapper drops onto the page from above: oversized,
 *  rotated, then settles. Reserved for the TRUE stamp moments. */
export function StampIn({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from(el, {
          scale: 2.4,
          rotation: -9,
          opacity: 0,
          duration: 0.55,
          delay,
          ease: "expo.out",
          transformOrigin: "center center",
          immediateRender: false, // never strand the stamp invisible
          scrollTrigger: { trigger: el, start: "top 95%", once: true },
        });
      });
    },
    { scope: ref }
  );
  return (
    <span ref={ref} className={className} style={{ display: "inline-block" }}>
      {children}
    </span>
  );
}

/** Tally — counts a number into place. SSR renders the final figure, so
 *  no-JS and reduced-motion both read correctly. */
export function Tally({
  value,
  decimals = 2,
  signed = false,
  suffix = "",
  className,
  style,
}: {
  value: number;
  decimals?: number;
  signed?: boolean;
  suffix?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const fmt = (v: number) =>
    `${signed && v > 0 ? "+" : ""}${v.toFixed(decimals)}${suffix}`;

  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        const obj = { v: 0 };
        gsap.to(obj, {
          v: value,
          duration: 1.5,
          ease: "power3.out",
          scrollTrigger: { trigger: el, start: "top 95%", once: true },
          onUpdate: () => {
            el.textContent = fmt(obj.v);
          },
        });
      });
    },
    { scope: ref }
  );

  return (
    <span ref={ref} className={className} style={style}>
      {fmt(value)}
    </span>
  );
}
