import type { ElementKind, InfraElement } from "./elements";
import type { CheckoutLineItem } from "../api/mocks/payments";

// Pure, client-side pricing estimate. Mirrors a typical usage-based PaaS plan.
// Values are illustrative; the real backend would return authoritative prices.

const BASE_PRICE_CENTS: Record<ElementKind, number> = {
  web: 700,
  api: 1200,
  worker: 900,
  database: 1500,
  cache: 800,
  broker: 1000,
  bucket: 500,
};

function memoryMultiplier(memoryLimit: string): number {
  const match = memoryLimit.trim().match(/^(\d+)(Mi|Gi)$/i);
  if (!match) return 1;
  const value = Number(match[1]);
  const mb = match[2].toLowerCase() === "gi" ? value * 1024 : value;
  return Math.max(1, mb / 512);
}

export function priceForElement(element: InfraElement): number {
  const base = BASE_PRICE_CENTS[element.kind];
  // Backing services and buckets bill at a flat rate; compute scales with size.
  if (element.kind === "database" || element.kind === "cache" || element.kind === "broker" || element.kind === "bucket") {
    return base;
  }
  return Math.round(base * memoryMultiplier(element.resources.memory_limit));
}

export interface PriceBreakdown {
  lineItems: CheckoutLineItem[];
  monthlyTotalCents: number;
}

export function computePricing(elements: InfraElement[]): PriceBreakdown {
  const lineItems: CheckoutLineItem[] = elements.map((element) => ({
    label: `${element.label} (${element.kind})`,
    amountCents: priceForElement(element),
    quantity: 1,
  }));
  const monthlyTotalCents = lineItems.reduce(
    (sum, item) => sum + item.amountCents * item.quantity,
    0
  );
  return { lineItems, monthlyTotalCents };
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
