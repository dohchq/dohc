import { createFileRoute } from '@tanstack/react-router'

// Render a folder-local `.views/<name>` package by URL-safe package ref.
// The app shell decodes the ref and renders the selected view.
export const Route = createFileRoute('/_app/w/$wsId/v/$viewRef')({
  component: () => null,
})
