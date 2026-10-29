declare module "*.css" {}

// Vite's `?raw` import: the file's exact bytes as a string.
declare module "*.css?raw" {
  const text: string;
  export default text;
}

// Vite's `?worker&url` import: the built worker's URL, named by its contents.
declare module "*?worker&url" {
  const url: string;
  export default url;
}

// Vite sets DEV in its dev server and in tests.
interface ImportMeta {
  readonly env: { readonly DEV: boolean };
}
