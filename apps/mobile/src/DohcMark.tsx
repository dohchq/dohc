import { DOHC_DOT, DOHC_LOBE_PATH } from "@dohc/brand";
import Svg, { Circle, Path } from "react-native-svg";

// The dohc drop-lobe mark from @dohc/brand, drawn natively: a stroked lobe and its datum dot in one colour.
export function DohcMark({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={Math.round((size * 104) / 96)} viewBox="0 0 96 104" accessibilityElementsHidden>
      <Path d={DOHC_LOBE_PATH} fill="none" stroke={color} strokeLinejoin="round" strokeWidth={8} />
      <Circle cx={DOHC_DOT.cx} cy={DOHC_DOT.cy} r={DOHC_DOT.r} fill={color} />
    </Svg>
  );
}
