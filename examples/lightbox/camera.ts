interface CameraSettings {
  readonly camera?: string;
  readonly lens?: string;
  readonly iso?: number;
  readonly fNumber?: number;
  readonly exposureS?: number;
  readonly focalMm?: number;
}

const EXIF_BYTES = 256 * 1024;

export async function readCameraSettings(file: Blob): Promise<CameraSettings | null> {
  if (file.type !== "image/jpeg") return null;
  try {
    return parseCameraSettings(new DataView(await file.slice(0, EXIF_BYTES).arrayBuffer()));
  } catch {
    return null;
  }
}

function parseCameraSettings(view: DataView): CameraSettings | null {
  if (view.getUint16(0) !== 0xffd8) return null;
  let at = 2;
  while (at + 10 <= view.byteLength) {
    const marker = view.getUint16(at);
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return null;
    if (marker === 0xffe1 && view.getUint32(at + 4) === 0x45786966 && view.getUint16(at + 8) === 0)
      return readTiff(view, at + 10);
    at += 2 + view.getUint16(at + 2);
  }
  return null;
}

function readTiff(view: DataView, base: number): CameraSettings | null {
  const order = view.getUint16(base);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const little = order === 0x4949;
  const u16 = (at: number) => view.getUint16(base + at, little);
  const u32 = (at: number) => view.getUint32(base + at, little);
  if (u16(2) !== 42) return null;
  const rational = (at: number) => {
    const below = u32(at + 4);
    return below ? u32(at) / below : undefined;
  };
  const ascii = (at: number, count: number) => {
    let value = "";
    for (let index = 0; index < count; index++) {
      const code = view.getUint8(base + at + index);
      if (!code) break;
      value += String.fromCharCode(code);
    }
    return value.trim();
  };
  const tags = new Map<number, string | number>();
  const read = (ifd: number) => {
    const count = u16(ifd);
    for (let index = 0; index < count; index++) {
      const entry = ifd + 2 + index * 12;
      const type = u16(entry + 2);
      const length = u32(entry + 4);
      const value =
        type === 2
          ? ascii(length <= 4 ? entry + 8 : u32(entry + 8), length)
          : type === 3
            ? u16(entry + 8)
            : type === 4
              ? u32(entry + 8)
              : type === 5
                ? rational(u32(entry + 8))
                : undefined;
      if (value !== undefined && value !== "") tags.set(u16(entry), value);
    }
  };
  read(u32(4));
  const exif = tags.get(0x8769);
  if (typeof exif === "number") read(exif);
  const words = (tag: number) => {
    const value = tags.get(tag);
    const clean =
      typeof value === "string"
        ? value
            .replace(/[\u0000-\u001f\u007f]/g, "")
            .trim()
            .slice(0, 80)
            .trim()
        : "";
    return clean || undefined;
  };
  const amount = (tag: number, min: number, max: number) => {
    const value = tags.get(tag);
    return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
      ? value
      : undefined;
  };
  const iso = amount(0x8827, 1, 1000000);
  const make = words(0x010f);
  const model = words(0x0110);
  const settings: CameraSettings = {
    camera:
      model && make && !model.toLowerCase().startsWith(make.split(" ")[0]!.toLowerCase())
        ? `${make} ${model}`.slice(0, 80)
        : model,
    lens: words(0xa434),
    iso: iso === undefined ? undefined : Math.round(iso),
    fNumber: amount(0x829d, 0.5, 128),
    exposureS: amount(0x829a, 0.00001, 3600),
    focalMm: amount(0x920a, 1, 5000),
  };
  const kept = Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== undefined),
  );
  return Object.keys(kept).length ? kept : null;
}

export function describeExposure(settings: {
  iso: number | null;
  fNumber: number | null;
  exposureS: number | null;
  focalMm: number | null;
}): string[] {
  const { iso, fNumber, exposureS, focalMm } = settings;
  return [
    iso ? `ISO ${iso}` : "",
    fNumber ? `f/${Math.round(fNumber * 10) / 10}` : "",
    exposureS
      ? exposureS <= 0.5
        ? `1/${Math.round(1 / exposureS)} s`
        : `${Math.round(exposureS * 10) / 10} s`
      : "",
    focalMm ? `${Math.round(focalMm)} mm` : "",
  ].filter(Boolean);
}
