import { useMemo } from "react";
import { toQR } from "toqr";
import { phoneConnectCode } from "@dohc/workspace-contracts/phone-connect";
import { palette } from "../tokens";
import { SettingRow } from "./SettingRow";

// A QR code needs dark modules on a light ground, with 4 light modules around them, so the code keeps the light
// theme's paper and ink in both themes.
const QUIET_ZONE = 4;
// About 4 px a module for a server address, which a phone reads from arm's length.
const SIZE = 160;

// The code the phone app scans on Connect. It holds this computer's server origin and nothing else
// (@dohc/workspace-contracts/phone-connect); the phone signs in to that server on its own.
export function PhoneConnectRow(props: { serverOrigin: string }) {
  const code = phoneConnectCode(props.serverOrigin);
  const server = new URL(code).host;
  const { side, path } = useMemo(() => qrPath(toQR(code)), [code]);
  return (
    <SettingRow title="Connect a phone" description={server} testId="settings-row-connect-phone">
      <div className="overflow-hidden rounded-lg border border-line">
        <svg
          role="img"
          aria-label={`QR code for ${server}`}
          data-testid="phone-connect-code"
          viewBox={`0 0 ${side} ${side}`}
          width={SIZE}
          height={SIZE}
          shapeRendering="crispEdges"
          className="block"
        >
          <rect width={side} height={side} fill={palette.light.bg} />
          <path d={path} fill={palette.light.ink} />
        </svg>
      </div>
    </SettingRow>
  );
}

// One rectangle for each run of dark modules in a row, inside the quiet zone. toQR gives the modules row by row.
function qrPath(modules: Uint8Array): { side: number; path: string } {
  const width = Math.sqrt(modules.length);
  let path = "";
  for (let y = 0; y < width; y++) {
    let x = 0;
    while (x < width) {
      if (!modules[y * width + x]) {
        x += 1;
        continue;
      }
      let run = 1;
      while (x + run < width && modules[y * width + x + run]) run += 1;
      path += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h${run}v1h-${run}z`;
      x += run;
    }
  }
  return { side: width + 2 * QUIET_ZONE, path };
}
