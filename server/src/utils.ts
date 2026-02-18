/**
 * Helper to clean scraped addresses
 */
export function cleanAddress(raw: string): string {
  if (!raw) return "";

  let cleaned = raw;

  // 1. Handle "·" separator (Google Maps format: "Name · Address · Hours")
  if (cleaned.includes("·")) {
    const parts = cleaned.split("·");
    // Find the part that looks like a street address (starts with number)
    // AND isn't a rating "4.5(200)"
    const addrPart = parts.find(
      (p) => /^\s*\d+\s+[A-Za-z]+/.test(p) && !/^\s*\d\.\d\(\d+\)/.test(p),
    );

    if (addrPart) {
      cleaned = addrPart.trim();
    } else {
      // If no street address found, it might be a location string like "Ottawa, ON"
      // Try to find a part that has a comma and isn't hours/phone
      const locPart = parts.find(
        (p) => p.includes(",") && !/Open|Closes|hours/i.test(p),
      );
      if (locPart) {
        cleaned = locPart.trim();
      } else {
        // Fallback: just strip the first part (Name) and take the rest if meaningful?
        // Actually, usually the second part is the address.
        if (parts.length >= 2) {
          const candidate = parts[1].trim();
          if (!/^\d\.\d\(\d+\)/.test(candidate)) cleaned = candidate;
        }
      }
    }
  }

  // 2. Remove trailing "Open", "Closes", etc.
  cleaned = cleaned.replace(/(Open|Closes|Opens|24\s*hours).*$/i, "").trim();

  // 3. Remove "Rating(Count) Category" prefix if it exists at the start
  // e.g. "3.1(18)Car wash " or "4.5(500) "
  cleaned = cleaned.replace(/^[\d\.]+\(\d+\)\s*([A-Za-z\s]+)?/, "").trim();

  // 4. Remove leading special chars
  cleaned = cleaned.replace(/^[\s·\-,]+/, "").trim();

  // 5. CAREFUL: Do NOT strip leading non-digits unless they are clearly junk keyworks
  // e.g. "Car wash 123 Main St" -> "123 Main St"
  // But "Ottawa, ON" -> Keep "Ottawa, ON"
  // Regex: Remove "Car wash", "Auto spa", "Detailing", "Gas station" at start
  cleaned = cleaned
    .replace(/^(Car wash|Auto spa|Detailing|Gas station)\s+/i, "")
    .trim();

  return cleaned;
}

// ---------------------------------------------------------------------------
// Brand & Wash-Type Detection
// ---------------------------------------------------------------------------

const BRAND_PATTERNS: Array<{ name: string; patterns: RegExp[] }> = [
  { name: "Petro-Canada", patterns: [/petro[- ]?canada/i, /petro[- ]?pass/i] },
  { name: "Shell", patterns: [/shell/i] },
  { name: "Esso", patterns: [/esso/i] },
  { name: "Mobil", patterns: [/mobil/i] },
  { name: "Circle K", patterns: [/circle[- ]?k/i] },
  { name: "Irving", patterns: [/irving/i] },
  { name: "Ultramar", patterns: [/ultramar/i] },
  { name: "Pioneer", patterns: [/pioneer/i] },
  { name: "Canadian Tire", patterns: [/canadian\s*tire/i, /gas\s*\+?/i] },
  { name: "Costco", patterns: [/costco/i] },
  { name: "Husky", patterns: [/husky/i] },
  { name: "Chevron", patterns: [/chevron/i] },
  { name: "7-Eleven", patterns: [/7-eleven/i, /7-11/i] },
  { name: "Marathon", patterns: [/marathon/i] },
  { name: "Speedway", patterns: [/speedway/i] },
  { name: "BP", patterns: [/bp/i] },
  { name: "Sunoco", patterns: [/sunoco/i] },
  { name: "Valero", patterns: [/valero/i] },
  { name: "Citgo", patterns: [/citgo/i] },
  { name: "Sheetz", patterns: [/sheetz/i] },
  { name: "Wawa", patterns: [/wawa/i] },
  { name: "Pilot Flying J", patterns: [/pilot/i, /flying\s*j/i] },
  { name: "Love's", patterns: [/love'?s/i] },
  { name: "Mister Car Wash", patterns: [/mister\s*car\s*wash/i] },
  { name: "Autobell", patterns: [/autobell/i] },
  { name: "Zips", patterns: [/zips/i] },
  { name: "Quick Quack", patterns: [/quick\s*quack/i] },
  { name: "Tommy's Express", patterns: [/tommy'?s\s*express/i] },
  { name: "Delta Sonic", patterns: [/delta\s*sonic/i] },
  { name: "Brown Bear", patterns: [/brown\s*bear/i] },
  { name: "Halo", patterns: [/halo/i] },
  { name: "Zoom", patterns: [/zoom/i] },
  { name: "Splash", patterns: [/splash/i] },
];

const WASH_TYPE_PATTERNS: Array<{ type: string; patterns: RegExp[] }> = [
  { type: "touchless", patterns: [/touchless/i, /touch-free/i, /laser/i] },
  {
    type: "self-serve",
    patterns: [/self[- ]?serve/i, /coin/i, /wand/i, /bay/i],
  },
  {
    type: "hand-wash",
    patterns: [/hand[- ]?wash/i, /detail/i, /interior/i, /full[- ]?service/i],
  },
  { type: "automatic", patterns: [/automatic/i, /tunnel/i, /soft[- ]?cloth/i] },
];

export function detectBrandAndType(
  name: string,
  _address: string,
): { brand: string | null; washType: string | null } {
  const text = name;

  let detectedBrand: string | null = null;
  for (const b of BRAND_PATTERNS) {
    if (b.patterns.some((p) => p.test(text))) {
      detectedBrand = b.name;
      break;
    }
  }

  let detectedType: string | null = null;
  for (const t of WASH_TYPE_PATTERNS) {
    if (t.patterns.some((p) => p.test(text))) {
      detectedType = t.type;
      break;
    }
  }

  if (
    !detectedType &&
    /car\s*wash|auto\s*wash/i.test(text) &&
    !/hand|detail|self/i.test(text)
  ) {
    detectedType = "automatic";
  }

  return { brand: detectedBrand, washType: detectedType };
}
