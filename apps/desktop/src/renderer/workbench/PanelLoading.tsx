export function PanelLoading({ label }: { label: string }) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 text-xs text-subtle">
      Loading {label}...
    </div>
  );
}
