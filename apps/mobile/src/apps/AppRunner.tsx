import { Stack, useRouter } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { AppWebView } from "../../modules/app-web-view";
import { useAccount, useSignIn } from "../account/AccountProvider";
import { useTheme } from "../theme";
import { HoldScreen } from "../workspace/ListStates";
import { createNavigationRule, externalLink } from "./appNavigation";
import type { RunningApp } from "./appStore";
import { offerLink } from "./offerLink";

// The running app, full screen in its own web view. The screen opens as its launch starts, and shows loading until it
// runs. Native Back closes it, and the screen leaves whenever the runner ends the app or its launch. When its web
// process dies, the runner stops it, and its review says so (AppReview.tsx). While it runs, the workspace's apps are
// read again every CHECK_MS and on each return to the foreground, so a revoke on another phone or a withdrawn
// publication closes it within that time; the server has already ended the app's access.
//
// On Android the app runs in AppWebView (modules/app-web-view), which decides its loads in native code. On iOS the
// WebView's settings are pinned for the app sandbox:
// - `originWhitelist` lets every address reach the navigation rule, so react-native-webview never hands one to the
//   system itself;
// - no window opens. A tapped link opens in Safari only when externalLink allows it and the person says so, since
//   WebKit alone decides whether a tap was needed;
// - nothing is decided from a load event or `navigationType`, which the app can fire.
const CHECK_MS = 15_000;
const ANY_ORIGIN = ["*"];
const ignore = () => undefined;

export function AppRunScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { runner, apps } = useAccount();
  const { origin } = useSignIn();
  const running = useSyncExternalStore(runner.subscribe, runner.state);
  const launching = useSyncExternalStore(runner.subscribe, runner.launching);
  useEffect(() => {
    if (!running && !launching && router.canGoBack()) router.back();
  }, [running, launching, router]);
  // Leaving the screen, by Back or otherwise, ends the app, but keeps a stopped app for its review to show.
  useEffect(
    () => () => {
      const kept = runner.stopped();
      runner.end((scope) => scope !== kept);
    },
    [runner],
  );
  useEffect(() => {
    if (!apps) return;
    const timer = setInterval(() => void apps.check(), CHECK_MS);
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void apps.check();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [apps]);
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Stack.Screen
        options={{
          title: running?.name ?? launching?.name ?? "",
          headerTransparent: false,
          headerStyle: { backgroundColor: theme.bg },
          headerShadowVisible: false,
        }}
      />
      {running && AppWebView ? (
        <AndroidAppView
          key={running.key}
          app={running}
          serverOrigin={origin}
          onEnd={() => runner.stop()}
        />
      ) : running ? (
        <AppView
          key={running.key}
          app={running}
          serverOrigin={origin}
          onStopped={() => runner.stop()}
        />
      ) : launching ? (
        <HoldScreen />
      ) : null}
    </View>
  );
}

function AppView({
  app,
  serverOrigin,
  onStopped,
}: {
  app: RunningApp;
  serverOrigin: string;
  onStopped(): void;
}) {
  const theme = useTheme();
  const [allows] = useState(() => createNavigationRule(app.action));
  return (
    <WebView
      style={{ flex: 1, backgroundColor: theme.bg }}
      source={{
        uri: app.action,
        method: "POST",
        body: `handoff=${encodeURIComponent(app.handoff)}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }}
      incognito
      cacheEnabled={false}
      sharedCookiesEnabled={false}
      javaScriptCanOpenWindowsAutomatically={false}
      originWhitelist={ANY_ORIGIN}
      onShouldStartLoadWithRequest={allows}
      onOpenWindow={(event) => {
        const url = externalLink(event.nativeEvent.targetUrl, app.action, serverOrigin);
        if (url) offerLink(url);
      }}
      onFileDownload={ignore}
      onContentProcessDidTerminate={onStopped}
      mediaCapturePermissionGrantType="deny"
      allowsLinkPreview={false}
      allowsPictureInPictureMediaPlayback={false}
    />
  );
}

function AndroidAppView({
  app,
  serverOrigin,
  onEnd,
}: {
  app: RunningApp;
  serverOrigin: string;
  onEnd(): void;
}) {
  // Android draws under the keyboard and the system bar, so the app's view ends above both, and scrolls its focused
  // field into sight.
  const keyboard = useKeyboardState((state) => (state.isVisible ? state.height : 0));
  const { bottom } = useSafeAreaInsets();
  if (!AppWebView) return null;
  return (
    <AppWebView
      style={{ flex: 1, marginBottom: Math.max(keyboard, bottom) }}
      bootstrap={app.action}
      handoff={app.handoff}
      onOpenLink={(event) => {
        const url = externalLink(event.nativeEvent.url, app.action, serverOrigin);
        if (url) offerLink(url);
      }}
      onEnd={onEnd}
    />
  );
}
