/**
 * Detects whether a search query names a language/film-industry, so the
 * pipeline can (a) tell the AI to recommend titles in that original language
 * and (b) prefer TMDB candidates whose original_language matches when
 * resolving the AI's title|year output.
 *
 * Detection is intentionally conservative: an exact token match against a
 * curated alias list, then a fuzzy pass (Damerau-Levenshtein) that only
 * considers tokens of 6+ chars sharing the alias's first letter — typos
 * rarely change the first letter, and this blocks real-word collisions like
 * "trench" -> "french" or "spawn" -> "spain".
 */

// ISO 639-1 code -> display name + query aliases (lowercase).
// Industry nicknames (bollywood, kollywood...) are high-signal and included.
const LANGUAGES = {
  en: { name: "English", aliases: ["english", "hollywood"] },
  hi: { name: "Hindi", aliases: ["hindi", "bollywood"] },
  ta: { name: "Tamil", aliases: ["tamil", "kollywood"] },
  te: { name: "Telugu", aliases: ["telugu", "tollywood"] },
  ml: { name: "Malayalam", aliases: ["malayalam", "mollywood"] },
  kn: { name: "Kannada", aliases: ["kannada", "sandalwood"] },
  bn: { name: "Bengali", aliases: ["bengali", "bangla"] },
  mr: { name: "Marathi", aliases: ["marathi"] },
  pa: { name: "Punjabi", aliases: ["punjabi"] },
  gu: { name: "Gujarati", aliases: ["gujarati"] },
  ur: { name: "Urdu", aliases: ["urdu"] },
  ko: { name: "Korean", aliases: ["korean", "korea", "kdrama"] },
  ja: { name: "Japanese", aliases: ["japanese", "japan", "anime", "jdrama"] },
  zh: { name: "Chinese", aliases: ["chinese", "mandarin", "cantonese", "china"] },
  fr: { name: "French", aliases: ["french", "france"] },
  es: { name: "Spanish", aliases: ["spanish", "spain", "mexican", "mexico", "argentine"] },
  de: { name: "German", aliases: ["german", "germany"] },
  it: { name: "Italian", aliases: ["italian", "italy"] },
  pt: { name: "Portuguese", aliases: ["portuguese", "portugal", "brazilian", "brazil"] },
  ru: { name: "Russian", aliases: ["russian", "russia"] },
  pl: { name: "Polish", aliases: ["polish", "poland"] },
  tr: { name: "Turkish", aliases: ["turkish"] },
  th: { name: "Thai", aliases: ["thai", "thailand"] },
  id: { name: "Indonesian", aliases: ["indonesian", "indonesia"] },
  vi: { name: "Vietnamese", aliases: ["vietnamese", "vietnam"] },
  ar: { name: "Arabic", aliases: ["arabic"] },
  fa: { name: "Persian", aliases: ["persian", "farsi", "iranian", "iran"] },
  he: { name: "Hebrew", aliases: ["hebrew", "israeli"] },
  el: { name: "Greek", aliases: ["greek"] },
  sv: { name: "Swedish", aliases: ["swedish", "sweden"] },
  no: { name: "Norwegian", aliases: ["norwegian", "norway"] },
  da: { name: "Danish", aliases: ["danish", "denmark"] },
  fi: { name: "Finnish", aliases: ["finnish", "finland"] },
  nl: { name: "Dutch", aliases: ["dutch"] },
  cs: { name: "Czech", aliases: ["czech"] },
  hu: { name: "Hungarian", aliases: ["hungarian"] },
  ro: { name: "Romanian", aliases: ["romanian"] },
  uk: { name: "Ukrainian", aliases: ["ukrainian", "ukraine"] },
};

// alias -> code, insertion order preserved for the fuzzy pass
const ALIAS_INDEX = new Map();
for (const [code, def] of Object.entries(LANGUAGES)) {
  for (const alias of def.aliases) ALIAS_INDEX.set(alias, code);
}

/**
 * Optimal string alignment distance (Damerau-Levenshtein with adjacent
 * transpositions counted as one edit — covers "malayalm" -> "malayalam").
 */
function osaDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0)
  );
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * Returns the ISO 639-1 code of a language the query names, or null.
 * e.g. "latest malayalam movies" -> "ml", "malayalm thriller" -> "ml",
 *      "k-drama about revenge" -> "ko", "time loop movie" -> null
 */
function detectQueryLanguage(query) {
  if (!query || typeof query !== "string") return null;

  const tokens = query
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

  // Exact pass — single tokens plus adjacent-pair joins ("k-drama" -> "kdrama")
  const candidates = [...tokens];
  for (let i = 0; i < tokens.length - 1; i++) {
    candidates.push(tokens[i] + tokens[i + 1]);
  }
  for (const tok of candidates) {
    if (ALIAS_INDEX.has(tok)) return ALIAS_INDEX.get(tok);
  }

  // Fuzzy pass — conservative on purpose (see header comment)
  for (const tok of tokens) {
    if (tok.length < 6) continue;
    for (const [alias, code] of ALIAS_INDEX) {
      if (alias.length < 6) continue;
      if (alias[0] !== tok[0]) continue;
      const max = alias.length >= 9 ? 2 : 1;
      if (osaDistance(tok, alias, max) <= max) return code;
    }
  }

  return null;
}

/** Display name for a detected code, e.g. "ml" -> "Malayalam". */
function getLanguageName(code) {
  return (code && LANGUAGES[code] && LANGUAGES[code].name) || null;
}

module.exports = { detectQueryLanguage, getLanguageName, LANGUAGES };
