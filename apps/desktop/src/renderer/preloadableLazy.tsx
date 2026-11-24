import { lazy, useState, type ComponentType } from "react";

// A lazy view whose code can load before anyone opens it. React.lazy suspends
// on its first render even when its module has loaded, and React holds that
// reveal for up to 300ms. A mount after `preload` resolves renders the loaded
// view in its first commit instead.
export function preloadableLazy<Props extends object>(load: () => Promise<ComponentType<Props>>) {
  let loaded: ComponentType<Props> | null = null;
  let loading: Promise<ComponentType<Props>> | null = null;
  const start = () =>
    (loading ??= load().then(
      (component) => {
        loaded = component;
        return component;
      },
      (error: unknown) => {
        // A failed preload leaves the view's own load to try again.
        loading = null;
        throw error;
      },
    ));
  const Lazy = lazy(() => start().then((component) => ({ default: component })));

  function PreloadableView(props: Props) {
    // Chosen once per mount: changing the type later would remount the view.
    const [View] = useState<ComponentType<Props>>(() => loaded ?? Lazy);
    return <View {...props} />;
  }
  const preload = (): Promise<void> =>
    start().then(
      () => undefined,
      () => undefined,
    );
  return Object.assign(PreloadableView, { preload });
}
