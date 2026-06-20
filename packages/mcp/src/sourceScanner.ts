const LEGACY_APP_PACKAGE = `@dohc/${"app"}`;
const LEGACY_APP_IMPORT_RE = new RegExp(
  String.raw`(?:import\s+(?:[^'"]+\s+from\s+)?|import\s*\(|require\s*\()\s*["']${LEGACY_APP_PACKAGE.replace("/", "\\/")}(?:\/[^"']*)?["']`,
  "m",
);

export function stripSourceComments(body: string): string {
  let output = "";
  let quote: "'" | "\"" | "`" | null = null;
  let regexLiteral = false;
  let regexCharClass = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let currentWord = "";
  let previousToken = "";

  function rememberToken(char: string) {
    if (/[\w$]/.test(char)) {
      currentWord += char;
      return;
    }
    if (currentWord) {
      previousToken = currentWord;
      currentWord = "";
    }
    if (!/\s/.test(char)) previousToken = char;
  }

  function canStartRegexLiteral() {
    if (currentWord) {
      previousToken = currentWord;
      currentWord = "";
    }
    return (
      previousToken === "" ||
      ["return", "throw", "case", "yield", "await", "typeof", "void", "delete"].includes(previousToken) ||
      "([{,;:=!?&|+-*~^<>".includes(previousToken)
    );
  }

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? "";
    const next = body[index + 1] ?? "";

    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false;
        output += char;
      }
      continue;
    }

    if (blockComment) {
      if (char === "\n" || char === "\r") output += char;
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (regexLiteral) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (regexCharClass) {
        if (char === "]") regexCharClass = false;
      } else if (char === "[") {
        regexCharClass = true;
      } else if (char === "/") {
        output += char;
        regexLiteral = false;
        previousToken = "literal";
      } else if (char === "\n" || char === "\r") {
        output += char;
      }
      continue;
    }

    if (quote) {
      if (quote !== "`") output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        if (quote === "`") output += char;
        quote = null;
        previousToken = "literal";
      } else if (char === "\n" || char === "\r") {
        output += char;
      }
      continue;
    }

    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && canStartRegexLiteral()) {
      regexLiteral = true;
      regexCharClass = false;
      output += char;
      continue;
    }

    output += char;
    rememberToken(char);
  }

  return output;
}

export function hasLegacyAppImport(source: string): boolean {
  // Static validation intentionally matches literal import/require specifiers.
  // Dynamic template imports are uncommon and will fail at runtime in normal
  // website previews.
  return LEGACY_APP_IMPORT_RE.test(stripSourceComments(source));
}
