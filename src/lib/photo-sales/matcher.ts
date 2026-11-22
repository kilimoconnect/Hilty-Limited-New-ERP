/**
 * Backup matcher for handwritten item text -> product, used when the photo
 * reader leaves an item unmatched. It expands the shop's short forms
 * ("W-guard" = weather guard, "Wallput" = wallputty, "20l" = 20lt, 3" = 3inch,
 * "1 1/2" = 1.5inch), requires the size to agree, and uses the unit price as
 * a tie-breaker. It only answers when one product is clearly best.
 */

export interface MatchProduct { id: string; name: string; price: number }

const SYN: [RegExp, string][] = [
  [/\bw[\s.-]*guard\b|\bwguard\b|\bwg\b/g, "weather guard"],
  [/\br[\s.-]*brush\b/g, "rbrush"],
  [/\bo[\s.-]*paint\b/g, "opaint"],
  [/\bf[\s.-]*tape\b/g, "ftape"],
  [/\bm[\s.-]*tape\b/g, "mtape"],
  [/\be[\s.-]*paints?\b/g, "epaint"],
  [/\bwall[\s.-]*put+(y|i)?\b|\bwallputty\b/g, "wallputty"],
  [/\bsulk\b|\bsilc\b|\bsille?\b/g, "silk"],
  [/\bsandpaper\b|\bs[\s.-]*paper\b/g, "msasa"],
  [/\breflect\w*\b|\breffle\w*\b/g, "reflector"],
  [/\bpva\b|\broof\b/g, "pva"],
  [/\ba[\s.-]*grey\b|\bascot grey\b/g, "agrey"],
  [/\bs[\s.-]*grey\b/g, "sgrey"],
  [/\bl[\s.-]*grey\b/g, "lgrey"],
  [/\bplascon\b/g, "plascon"],
];

/** Sizes: 20l / 20 lt / 20ltr -> 20lt; 3" / 3'' / 3 inch -> 3inch; 1 1/2 or 1½ -> 1.5inch (brushes); 25kg. */
function sizes(s: string): { text: string; size: string[] } {
  let t = s;
  t = t.replace(/(\d+)\s*1\/2\s*("|''|inch|in)?/g, (_m, a) => `${a}.5inch`).replace(/(\d+)\s*½/g, (_m, a) => `${a}.5inch`);
  // Inches only for brush-like sizes; 'Msasa 180"' is a sandpaper grade.
  t = t.replace(/(\d+(?:\.\d+)?)\s*("|''|”|inch(?:es)?|in\b)/g, (m, a) => (Number(a) <= 12 ? `${a}inch` : a));
  t = t.replace(/(\d+(?:\.\d+)?)\s*(lt|ltr|litre|liter|lts|l)\b/g, "$1lt");
  t = t.replace(/(\d+(?:\.\d+)?)\s*(kg|kgs)\b/g, "$1kg");
  t = t.replace(/(\d+(?:\.\d+)?)\s*ml\b/g, "$1ml");
  const size = Array.from(t.matchAll(/\b\d+(?:\.\d+)?(lt|inch|kg|ml)\b/g)).map((m) => m[0]);
  return { text: t, size };
}

export function normalizeItem(raw: string): { tokens: string[]; size: string[] } {
  let t = raw.toLowerCase().replace(/[()]/g, " ").replace(/[“”]/g, '"');
  for (const [re, rep] of SYN) t = t.replace(re, rep);
  const s = sizes(t);
  const tokens = s.text.split(/[^a-z0-9.]+/).filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") && !/\d/.test(w) ? w.slice(0, -1) : w))
    .filter((w) => !["paint", "base", "the", "of", "pl", "half"].includes(w));
  return { tokens: Array.from(new Set(tokens)), size: s.size };
}

export function makeMatcher(products: MatchProduct[]) {
  const prepared = products.map((p) => ({ p, ...normalizeItem(p.name), key: normalizeItem(p.name).tokens.slice().sort().join(" ") }));
  return (text: string, unitPrice: number | null): string | null => {
    const q = normalizeItem(text);
    if (q.tokens.length === 0) return null;
    const words = q.tokens.filter((t) => !/^\d/.test(t));
    const scored: { id: string; key: string; score: number; priceGap: number }[] = [];
    for (const c of prepared) {
      // A size on the receipt must be on the product (20lt is not 4lt).
      if (q.size.length && !q.size.every((s) => c.size.includes(s))) continue;
      // The first word names the kind of item (silk, brush, msasa...): it must be on the product.
      if (words.length && !c.tokens.includes(words[0])) continue;
      // A bare number ("Brush 1.5") may stand for a size on the product (1.5inch).
      const has = (t: string) => c.tokens.includes(t) || (/^\d+(\.\d+)?$/.test(t) && (c.tokens.includes(`${t}inch`) || c.tokens.includes(`${t}lt`)));
      const hit = q.tokens.filter(has).length;
      // Words on the product that the receipt does not mention (colour, size) count against it.
      let score = hit / q.tokens.length - 0.15 * Math.max(0, c.tokens.length - hit);
      let priceGap = 1;
      if (unitPrice && c.p.price > 0) {
        const ratio = unitPrice / c.p.price;
        priceGap = Math.abs(Math.log(ratio));
        if (ratio > 0.8 && ratio < 1.25) score += 0.25; else if (ratio < 0.4 || ratio > 2.5) score -= 0.3;
      }
      scored.push({ id: c.p.id, key: c.key, score, priceGap });
    }
    scored.sort((a, b) => b.score - a.score || a.priceGap - b.priceGap);
    const best = scored[0];
    if (!best || best.score < 0.6) return null;
    // The same product entered twice under one name: take the one nearest the price.
    const rival = scored.find((s) => s.key !== best.key);
    if (rival && best.score - rival.score < 0.12) return null;
    return best.id;
  };
}
