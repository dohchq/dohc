// Vite `?raw` text imports — tokens.test.ts parses styles.css and index.html
// as source text to enforce the single-source-of-truth sync with tokens.ts.
declare module "*.css" {}
declare module "*.css?raw" {
  const text: string;
  export default text;
}
declare module "*.html?raw" {
  const text: string;
  export default text;
}
