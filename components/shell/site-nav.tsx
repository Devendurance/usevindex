"use client";

import Link from "next/link";
import { Menu, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BrandMark } from "@/components/vindex/brand-mark";

const marketingLinks = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#for-treasuries", label: "For treasuries" },
  { href: "/audit/preview", label: "Audit trail" },
];

const productLinks = [
  { href: "/monitor", label: "Monitor" },
  { href: "/audit/preview", label: "Audit trail" },
  { href: "/settings", label: "Settings" },
];

export function SiteNav({ variant = "marketing" }: { variant?: "marketing" | "product" }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const links = variant === "marketing" ? marketingLinks : productLinks;

  const isActive = (href: string) => {
    const path = href.split("#")[0] || "/";
    if (path === "/") return pathname === "/";
    return pathname === path || pathname.startsWith(`${path}/`);
  };

  const closeMenu = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <header className={`site-nav site-nav--${variant}`}>
      <div className="content-wrap site-nav__inner">
        <Link href={variant === "marketing" ? "/" : "/monitor"} className="site-nav__brand" aria-label="Vindex home">
          <BrandMark />
        </Link>

        <nav className="site-nav__links" aria-label={variant === "marketing" ? "Main navigation" : "Product navigation"}>
          {links.map((link) => (
            <Link key={link.href} href={link.href} className={isActive(link.href) ? "is-active" : ""} aria-current={isActive(link.href) ? "page" : undefined} onClick={closeMenu}>
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="site-nav__actions">
          {variant === "marketing" ? (
            <Link className="secondary-button site-nav__demo" href="/demo">View demo</Link>
          ) : (
            <Link className="secondary-button site-nav__demo" href="/demo">View demo</Link>
          )}
          <button
            ref={menuButtonRef}
            className="icon-button site-nav__menu-button"
            type="button"
            aria-label={open ? "Close navigation" : "Open navigation"}
            aria-expanded={open}
            aria-controls="mobile-navigation"
            onClick={() => setOpen((current) => !current)}
          >
            {open ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
          </button>
        </div>
      </div>

      <div id="mobile-navigation" className={`mobile-nav${open ? " is-open" : ""}`}>
        <nav aria-label="Mobile navigation">
          {links.map((link) => (
            <Link key={link.href} href={link.href} className={isActive(link.href) ? "is-active" : ""} aria-current={isActive(link.href) ? "page" : undefined} onClick={closeMenu}>{link.label}</Link>
          ))}
          <Link href="/demo" aria-current={pathname === "/demo" ? "page" : undefined} onClick={closeMenu}>View demo</Link>
        </nav>
      </div>
    </header>
  );
}
