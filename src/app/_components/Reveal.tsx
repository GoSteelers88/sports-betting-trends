"use client";

import { useEffect, useRef } from "react";
import { gsap } from "gsap";

// Wraps any block of content with a subtle fade-up entrance.
// Used on the homepage hero/picks/slate sections for the nightclub-y reveal.
export function Reveal({
  children,
  delay = 0,
  y = 18,
  duration = 0.6,
}: {
  children: React.ReactNode;
  delay?: number;
  y?: number;
  duration?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      gsap.set(ref.current, { opacity: 1, y: 0 });
      return;
    }
    const ctx = gsap.context(() => {
      gsap.fromTo(
        ref.current,
        { opacity: 0, y },
        { opacity: 1, y: 0, duration, delay, ease: "power2.out" }
      );
    }, ref);
    return () => ctx.revert();
  }, [delay, y, duration]);

  return <div ref={ref}>{children}</div>;
}
