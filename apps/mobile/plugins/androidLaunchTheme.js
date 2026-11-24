// Android's launch and window theme, in dohc's colours instead of Expo's template:
// - The system splash (Android 12 and later) is the paper background with the dohc mark, light or dark as the phone is,
//   not a white screen with the launcher icon's square.
// - The window under the app is the same paper, so the moment between the splash and the first screen shows no grey.
// - The app theme is Material 3, so a system dialog (an Alert, a confirmation) has sentence-case buttons in dohc's
//   accent, on the raised surface with Material 3's 28 dp corners.
// The colours are bg, raised and accent from src/theme.ts; the mark is @dohc/brand's, read from its source.
const fs = require("fs");
const path = require("path");
const {
  withAndroidColors,
  withAndroidColorsNight,
  withAndroidStyles,
  withDangerousMod,
  AndroidConfig,
} = require("expo/config-plugins");

const LIGHT = { bg: "#faf9f5", raised: "#f3f1ea", accent: "#2d342e" };
const DARK = { bg: "#131211", raised: "#201f1c", accent: "#d7d0c0" };

function brandMark() {
  const source = fs.readFileSync(
    path.join(__dirname, "../../../packages/brand/src/DohcLogo.tsx"),
    "utf8",
  );
  const lobe = source.match(/DOHC_LOBE_PATH =\s*"([^"]+)"/)?.[1];
  const dot = source.match(/DOHC_DOT = \{ cx: (\d+), cy: (\d+), r: (\d+) \}/);
  if (!lobe || !dot) throw new Error("androidLaunchTheme: the dohc mark moved in @dohc/brand");
  const [, cx, cy, r] = dot.map(Number);
  return { lobe, dot: `M${cx - r},${cy}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0` };
}

// Android 12's splash icon: a 288 dp square whose middle 192 dp circle shows. The 96 by 104 mark sits in its centre at
// 1.25 times, well inside the circle.
function splashMark(color) {
  const { lobe, dot } = brandMark();
  const scale = 1.25;
  return `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="288dp" android:height="288dp" android:viewportWidth="288" android:viewportHeight="288">
  <group android:translateX="${(288 - 96 * scale) / 2}" android:translateY="${(288 - 104 * scale) / 2}"
      android:scaleX="${scale}" android:scaleY="${scale}">
    <path android:pathData="${lobe}" android:strokeColor="${color}" android:strokeWidth="8"
        android:strokeLineJoin="round" android:fillColor="#00000000" />
    <path android:pathData="${dot}" android:fillColor="${color}" />
  </group>
</vector>
`;
}

// AppCompat's AlertDialog, which React Native's Alert uses, keeps a square window under Material 3's overlay.
const DIALOG_SURFACE = `<inset xmlns:android="http://schemas.android.com/apk/res/android"
    android:insetLeft="24dp" android:insetRight="24dp">
  <shape android:shape="rectangle">
    <corners android:radius="28dp" />
    <solid android:color="@color/dialog_surface" />
  </shape>
</inset>
`;

const SPLASH_V31 = `<resources>
  <style name="Theme.App.SplashScreen" parent="AppTheme">
    <item name="android:windowBackground">@color/splashscreen_background</item>
    <item name="android:windowSplashScreenBackground">@color/splashscreen_background</item>
    <item name="android:windowSplashScreenAnimatedIcon">@drawable/splash_mark</item>
  </style>
</resources>
`;

function setColors(config, night) {
  const colors = night ? DARK : LIGHT;
  const plugin = night ? withAndroidColorsNight : withAndroidColors;
  return plugin(config, (mod) => {
    for (const [name, value] of [
      ["splashscreen_background", colors.bg],
      ["colorPrimary", colors.accent],
      ["dialog_surface", colors.raised],
    ]) {
      mod.modResults = AndroidConfig.Colors.assignColorValue(mod.modResults, { name, value });
    }
    return mod;
  });
}

module.exports = function androidLaunchTheme(config) {
  config = setColors(config, false);
  config = setColors(config, true);
  config = withAndroidStyles(config, (mod) => {
    const styles = mod.modResults.resources.style ?? [];
    const app = styles.find((style) => style.$.name === "AppTheme");
    const splash = styles.find((style) => style.$.name === "Theme.App.SplashScreen");
    if (!app || !splash) throw new Error("androidLaunchTheme: the template's themes moved");
    app.$.parent = "Theme.Material3.DayNight.NoActionBar";
    const set = (style, name, value) => {
      style.item = (style.item ?? []).filter((item) => item.$.name !== name);
      style.item.push({ $: { name }, _: value });
    };
    set(app, "android:windowBackground", "@color/splashscreen_background");
    set(app, "alertDialogTheme", "@style/Theme.App.AlertDialog");
    // A prebuild over an earlier one finds the dialog's style already there.
    mod.modResults.resources.style = [
      ...styles.filter((style) => style.$.name !== "Theme.App.AlertDialog"),
      {
        $: { name: "Theme.App.AlertDialog", parent: "ThemeOverlay.Material3.Dialog.Alert" },
        item: [{ $: { name: "android:windowBackground" }, _: "@drawable/dialog_surface" }],
      },
    ];
    // Before Android 12 there is no system splash: the window shows the paper until the first screen draws.
    set(splash, "android:windowBackground", "@color/splashscreen_background");
    return mod;
  });
  return withDangerousMod(config, [
    "android",
    (mod) => {
      const res = path.join(mod.modRequest.platformProjectRoot, "app/src/main/res");
      for (const [folder, file, contents] of [
        ["drawable", "splash_mark.xml", splashMark(LIGHT.accent)],
        ["drawable-night", "splash_mark.xml", splashMark(DARK.accent)],
        ["drawable", "dialog_surface.xml", DIALOG_SURFACE],
        ["values-v31", "splash_theme.xml", SPLASH_V31],
      ]) {
        fs.mkdirSync(path.join(res, folder), { recursive: true });
        fs.writeFileSync(path.join(res, folder, file), contents);
      }
      return mod;
    },
  ]);
};
