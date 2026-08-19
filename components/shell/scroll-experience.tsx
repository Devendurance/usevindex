"use client";

import Lenis from "lenis";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

const REVEAL_SELECTOR = '[data-scroll-reveal="true"]';

export function ScrollExperience() {
  const pathname = usePathname();

  useEffect(() => {
    const root = document.documentElement;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const revealElements = Array.from(document.querySelectorAll<HTMLElement>(REVEAL_SELECTOR));

    if (reducedMotion.matches) {
      root.dataset.lenisEnabled = "false";
      revealElements.forEach((element) => {
        element.dataset.revealState = "visible";
      });
      return;
    }

    root.dataset.lenisEnabled = "true";
    const lenis = new Lenis({
      autoRaf: true,
      anchors: { offset: -78 },
      stopInertiaOnNavigate: true,
      respectReducedMotion: true,
    });
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          (entry.target as HTMLElement).dataset.revealState = "visible";
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.16, rootMargin: "0px 0px -8% 0px" },
    );

    revealElements.forEach((element) => {
      element.dataset.revealState = "hidden";
      observer.observe(element);
    });

    return () => {
      observer.disconnect();
      lenis.destroy();
      delete root.dataset.lenisEnabled;
    };
  }, [pathname]);

  return null;
}
