declare module "*.css" {}

// Vite's `?raw` import: the file's exact bytes as a string.
declare module "*.css?raw" {
  const text: string;
  export default text;
}
