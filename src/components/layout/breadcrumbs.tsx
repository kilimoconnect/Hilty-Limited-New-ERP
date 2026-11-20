"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { safePath } from "@/lib/back-link";

const LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  admin: "Admin",
  account: "My Account",
  company: "Company",
  branches: "Branches",
  products: "Products",
  "product-categories": "Product Categories",
  categories: "Categories",
  brands: "Brands",
  units: "Units of Measurement",
  "tax-codes": "Tax Codes",
  "payment-accounts": "Payment Accounts",
  "payment-methods": "Payment Methods & Banks",
  "other-income-types": "Other Income Types",
  "expense-categories": "Expense Categories",
  customers: "Customers",
  suppliers: "Suppliers",
  "chart-of-accounts": "Chart of Accounts",
  roles: "Roles & Permissions",
  users: "Users",
  "document-numbering": "Document Numbering",
  "accounting-periods": "Accounting Periods",
  "audit-log": "Audit Log",
  "cost-categories": "Cost Categories",
  "exchange-rates": "Exchange Rates",
  "feature-flags": "Feature Flags",
  "cash-and-banks": "Cash & Banks",
  "other-income": "Other Income",
  "customer-payments": "Customer Payments",
  "supplier-payments": "Supplier Payments",
  "supplier-credits": "Supplier Credits",
  inventory: "Inventory",
  kardex: "Kardex",
  history: "History",
  new: "New",
  orders: "Purchase Orders",
  generate: "Generate",
};

/** Sections whose own address is not a screen: where their crumb should go. */
const SECTION_HREF: Record<string, string> = {
  "/sales": "/sales/history",
  "/purchases": "/purchases/history",
  "/expenses": "/expenses/history",
  "/other-income": "/other-income/history",
  "/cash-and-banks/accounts": "/cash-and-banks",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_KEY = (path: string) => `hilty:crumb:${path}`;

function labelFor(segment: string) {
  return LABELS[segment] ?? segment.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Breadcrumbs for every page. Each crumb opens a real screen: sections without
 * a screen of their own go to their list (Sales -> Sales History), a list the
 * user came from (?back=) is used as is, and record ids show the record's name
 * (its page title, e.g. INV00108) instead of the raw id.
 */
function BreadcrumbsInner() {
  const pathname = usePathname();
  const sp = useSearchParams();
  const nav = React.useRef<HTMLElement>(null);
  const segments = pathname.split("/").filter(Boolean);
  const back = safePath(sp.get("back"));

  // Record crumbs: fill in the record's name once the page has rendered (and remember it
  // for when the record appears earlier in a trail, e.g. /sales/<id>/return).
  React.useEffect(() => {
    const root = nav.current;
    if (!root) return;
    const fill = () => {
      root.querySelectorAll<HTMLElement>("[data-crumb-id]").forEach((el) => {
        const path = el.dataset.crumbId!;
        let name: string | null = null;
        if (el.dataset.last === "1") {
          const h1 = document.querySelector("main h1")?.textContent?.trim();
          if (h1) { name = h1; try { sessionStorage.setItem(NAME_KEY(path), h1); } catch { /* private mode */ } }
        } else {
          try { name = sessionStorage.getItem(NAME_KEY(path)); } catch { /* private mode */ }
        }
        if (name) el.textContent = name.length > 40 ? `${name.slice(0, 40)}…` : name;
      });
    };
    fill();
    // The title can arrive after the crumbs (streamed page): watch for it briefly.
    const main = document.querySelector("main");
    const obs = main ? new MutationObserver(fill) : null;
    obs?.observe(main!, { childList: true, subtree: true });
    const stop = window.setTimeout(() => obs?.disconnect(), 8000);
    return () => { obs?.disconnect(); window.clearTimeout(stop); };
  }, [pathname]);

  if (segments.length === 0) return null;

  return (
    <nav ref={nav} aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm">
      {segments.map((seg, i) => {
        const path = "/" + segments.slice(0, i + 1).join("/");
        const isLast = i === segments.length - 1;
        // Where the crumb goes: the list the user came from when it belongs to this
        // section, else the section's screen.
        let href = SECTION_HREF[path] ?? path;
        if (back && !isLast && back.split("?")[0].startsWith(href.split("?")[0])) href = back;
        const isId = UUID.test(seg);
        const text = isId ? "Details" : labelFor(seg);
        const idProps = isId ? { "data-crumb-id": path, "data-last": isLast ? "1" : "0" } : {};
        return (
          <React.Fragment key={path}>
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />}
            {isLast ? (
              <span className="font-medium text-foreground" {...idProps}>{text}</span>
            ) : (
              <Link href={href} className="text-muted-foreground transition-colors hover:text-foreground" {...idProps}>{text}</Link>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

export function Breadcrumbs() {
  // useSearchParams needs a Suspense boundary.
  return <React.Suspense fallback={null}><BreadcrumbsInner /></React.Suspense>;
}
