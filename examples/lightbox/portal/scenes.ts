type Rng = () => number;
type Ctx = CanvasRenderingContext2D;

const SKIES = [
  ["#14213d", "#5b2a5e", "#e76f51", "#f4a261", "#ffd6a0"],
  ["#0d1b2a", "#3a3f73", "#b5651d", "#f2a65a", "#fde2b8"],
  ["#1b263b", "#415a77", "#a3b8c8", "#f1c6b0", "#fbe7d3"],
  ["#10302f", "#1f5f61", "#6fb3a6", "#f3d9a4", "#fff1d0"],
  ["#2b1225", "#6d2943", "#d1495b", "#f0a868", "#ffe0a3"],
  ["#0f1734", "#2d3e75", "#7c6fb0", "#e8a0bf", "#ffd9c7"],
];
const PASTELS = ["#f6c9a9", "#f2dfb4", "#e9a07f", "#f7e8d0", "#d98b6a", "#efc1b4", "#f4d58d", "#c6d8d3"];

function random(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string): number {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}

function mix(a: string, b: string, t: number): string {
  const parse = (hex: string) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  const [r1, g1, b1] = parse(a);
  const [r2, g2, b2] = parse(b);
  const lerp = (x: number, y: number) =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${lerp(r1!, r2!)}${lerp(g1!, g2!)}${lerp(b1!, b2!)}`;
}

function sky(ctx: Ctx, w: number, h: number, colors: string[], horizon: number) {
  const gradient = ctx.createLinearGradient(0, 0, 0, h * horizon);
  colors.forEach((color, index) => gradient.addColorStop(index / (colors.length - 1), color));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
}

function glow(ctx: Ctx, x: number, y: number, radius: number, color: string, alpha: number) {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = gradient;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  ctx.restore();
}

function ridge(rng: Rng, w: number, base: number, amplitude: number, roughness: number): number[] {
  const waves = Array.from({ length: 5 }, (_, index) => ({
    frequency: (index + 1) * (0.6 + rng() * 0.8) * roughness,
    phase: rng() * Math.PI * 2,
    weight: 1 / (index + 1) ** 1.3,
  }));
  const points: number[] = [];
  for (let x = 0; x <= w; x += 4) {
    let value = 0;
    for (const wave of waves) value += Math.sin((x / w) * Math.PI * 2 * wave.frequency + wave.phase) * wave.weight;
    points.push(base - value * amplitude);
  }
  return points;
}

function fillRidge(ctx: Ctx, points: number[], w: number, h: number, fill: string | CanvasGradient) {
  ctx.beginPath();
  ctx.moveTo(0, h);
  points.forEach((y, index) => ctx.lineTo(Math.min(index * 4, w), y));
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function haze(ctx: Ctx, w: number, y: number, height: number, color: string, alpha: number) {
  const gradient = ctx.createLinearGradient(0, y - height, 0, y + height);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(0.5, color);
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = gradient;
  ctx.fillRect(0, y - height, w, height * 2);
  ctx.restore();
}

function coast(ctx: Ctx, w: number, h: number, rng: Rng, colors: string[]) {
  const horizon = 0.58 + rng() * 0.08;
  sky(ctx, w, h, colors, horizon);
  const sunX = w * (0.3 + rng() * 0.4);
  const sunY = h * (horizon - 0.06 - rng() * 0.08);
  glow(ctx, sunX, sunY, Math.max(w, h) * 0.45, colors[3]!, 0.55);
  ctx.fillStyle = colors[4]!;
  ctx.beginPath();
  ctx.arc(sunX, sunY, Math.min(w, h) * 0.045, 0, Math.PI * 2);
  ctx.fill();
  const sea = ctx.createLinearGradient(0, h * horizon, 0, h);
  sea.addColorStop(0, mix(colors[2]!, colors[0]!, 0.35));
  sea.addColorStop(1, mix(colors[0]!, "#000000", 0.35));
  ctx.fillStyle = sea;
  ctx.fillRect(0, h * horizon, w, h);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let index = 0; index < 90; index++) {
    const y = h * horizon + (h * (1 - horizon) * index) / 90;
    const spread = (0.03 + (index / 90) * 0.22) * w;
    ctx.globalAlpha = 0.5 * (1 - index / 110) * (0.4 + rng() * 0.6);
    ctx.fillStyle = colors[4]!;
    const width = spread * (0.2 + rng() * 0.8);
    ctx.fillRect(sunX - width / 2 + (rng() - 0.5) * spread, y, width, Math.max(1, h * 0.003));
  }
  ctx.restore();
  const left = rng() > 0.5;
  const cliff = ridge(rng, w, h * (horizon + 0.02), h * 0.14, 0.7).map((y, index, all) => {
    const t = index / (all.length - 1);
    const edge = left ? 1 - t : t;
    return y - Math.max(0, edge - 0.45) * h * 0.95 + Math.max(0, 0.5 - edge) * h * 0.8;
  });
  const cliffFill = ctx.createLinearGradient(0, h * 0.2, 0, h);
  cliffFill.addColorStop(0, mix(colors[1]!, "#000000", 0.25));
  cliffFill.addColorStop(1, mix(colors[0]!, "#000000", 0.6));
  fillRidge(ctx, cliff, w, h, cliffFill);
  for (let index = 0; index < 70; index++) {
    const t = rng();
    const x = left ? t * w * 0.5 : w - t * w * 0.5;
    const top = cliff[Math.min(cliff.length - 1, Math.round(x / 4))]!;
    const y = top + rng() * (h * horizon - top + h * 0.05);
    if (y < top + 4) continue;
    const size = Math.min(w, h) * (0.012 + rng() * 0.018);
    ctx.fillStyle = PASTELS[Math.floor(rng() * PASTELS.length)]!;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x, y, size * 1.4, size);
    ctx.fillStyle = "rgba(40,20,30,0.55)";
    ctx.fillRect(x + size * 0.3, y + size * 0.35, size * 0.25, size * 0.3);
    ctx.globalAlpha = 1;
  }
  haze(ctx, w, h * horizon, h * 0.05, colors[3]!, 0.25);
}

function peaks(ctx: Ctx, w: number, h: number, rng: Rng, colors: string[]) {
  sky(ctx, w, h, colors, 0.75);
  const night = rng() > 0.6;
  if (night) {
    for (let index = 0; index < 260; index++) {
      ctx.globalAlpha = rng() * 0.8;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(rng() * w, rng() * h * 0.5, 1.4, 1.4);
    }
    ctx.globalAlpha = 1;
  }
  glow(ctx, w * (0.2 + rng() * 0.6), h * 0.42, Math.max(w, h) * 0.5, colors[3]!, 0.45);
  const layers = 5;
  for (let layer = 0; layer < layers; layer++) {
    const depth = layer / (layers - 1);
    const points = ridge(rng, w, h * (0.42 + depth * 0.36), h * (0.16 - depth * 0.06), 0.9 + depth);
    fillRidge(ctx, points, w, h, mix(colors[2]!, mix(colors[0]!, "#05060a", 0.5), 0.25 + depth * 0.75));
    haze(ctx, w, h * (0.5 + depth * 0.36), h * 0.04, colors[3]!, 0.12 * (1 - depth));
  }
}

function lagoon(ctx: Ctx, w: number, h: number, rng: Rng, colors: string[]) {
  const horizon = 0.52 + rng() * 0.08;
  sky(ctx, w, h, colors, horizon);
  glow(ctx, w * (0.25 + rng() * 0.5), h * horizon * 0.8, Math.max(w, h) * 0.4, colors[4]!, 0.4);
  const far = ridge(rng, w, h * horizon, h * 0.1, 0.8);
  const near = ridge(rng, w, h * horizon + h * 0.01, h * 0.05, 1.6);
  const farFill = mix(colors[1]!, colors[3]!, 0.25);
  const nearFill = mix(colors[0]!, "#000000", 0.35);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h * horizon);
  ctx.clip();
  fillRidge(ctx, far, w, h, farFill);
  fillRidge(ctx, near, w, h, nearFill);
  ctx.restore();
  ctx.save();
  ctx.translate(0, h * horizon * 2);
  ctx.scale(1, -1);
  ctx.globalAlpha = 0.55;
  ctx.drawImage(ctx.canvas, 0, 0, w, h * horizon, 0, 0, w, h * horizon);
  ctx.restore();
  const water = ctx.createLinearGradient(0, h * horizon, 0, h);
  water.addColorStop(0, "rgba(255,255,255,0.08)");
  water.addColorStop(1, mix(colors[0]!, "#000000", 0.4));
  ctx.fillStyle = water;
  ctx.fillRect(0, h * horizon, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  for (let index = 0; index < 40; index++) {
    const y = h * horizon + rng() * h * (1 - horizon);
    const x = rng() * w;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w * (0.05 + rng() * 0.15), y);
    ctx.stroke();
  }
  haze(ctx, w, h * horizon, h * 0.04, "#ffffff", 0.18);
  ctx.strokeStyle = "rgba(20,20,30,0.7)";
  ctx.lineWidth = Math.max(1.2, w * 0.0016);
  for (let index = 0; index < 5; index++) {
    const x = w * (0.55 + rng() * 0.35);
    const y = h * (0.15 + rng() * 0.2);
    const span = w * (0.008 + rng() * 0.008);
    ctx.beginPath();
    ctx.moveTo(x - span, y);
    ctx.quadraticCurveTo(x - span / 2, y - span * 0.6, x, y);
    ctx.quadraticCurveTo(x + span / 2, y - span * 0.6, x + span, y);
    ctx.stroke();
  }
}

function dunes(ctx: Ctx, w: number, h: number, rng: Rng, colors: string[]) {
  sky(ctx, w, h, [colors[2]!, colors[3]!, colors[4]!], 0.5);
  const sunX = w * (0.15 + rng() * 0.7);
  glow(ctx, sunX, h * 0.3, Math.max(w, h) * 0.5, colors[4]!, 0.5);
  const sand = [mix(colors[3]!, "#c2733f", 0.5), mix(colors[2]!, "#8a3b22", 0.4), mix(colors[1]!, "#2a1410", 0.5)];
  for (let layer = 0; layer < 4; layer++) {
    const base = h * (0.42 + layer * 0.16);
    const points = ridge(rng, w, base, h * 0.07, 0.5 + layer * 0.25);
    const fill = ctx.createLinearGradient(sunX - w * 0.4, base - h * 0.12, sunX + w * 0.9, base + h * 0.3);
    fill.addColorStop(0, mix(sand[0]!, "#ffffff", 0.15 - layer * 0.03));
    fill.addColorStop(0.5, sand[Math.min(2, layer)]!);
    fill.addColorStop(1, mix(sand[2]!, "#000000", 0.2 + layer * 0.1));
    fillRidge(ctx, points, w, h, fill);
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.max(1, w * 0.0012);
    ctx.beginPath();
    points.forEach((y, index) => (index ? ctx.lineTo(index * 4, y) : ctx.moveTo(0, y)));
    ctx.stroke();
    ctx.restore();
  }
}

function bokeh(ctx: Ctx, w: number, h: number, rng: Rng, colors: string[]) {
  const background = ctx.createLinearGradient(0, 0, w, h);
  background.addColorStop(0, mix(colors[0]!, "#000000", 0.55));
  background.addColorStop(1, mix(colors[1]!, "#000000", 0.45));
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const count = 70;
  for (let index = 0; index < count; index++) {
    const radius = Math.min(w, h) * (0.02 + rng() ** 2 * 0.11);
    const x = rng() * w;
    const y = h * (0.15 + rng() * 0.7) + Math.sin((x / w) * Math.PI * 2) * h * 0.08;
    const color = colors[2 + Math.floor(rng() * 3)]!;
    const gradient = ctx.createRadialGradient(x, y, radius * 0.2, x, y, radius);
    gradient.addColorStop(0, color);
    gradient.addColorStop(0.82, color);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = 0.12 + rng() * 0.3;
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.save();
  ctx.fillStyle = "rgba(8,6,10,0.88)";
  const cx = w * (0.38 + rng() * 0.24);
  const scale = Math.min(w, h) * 0.22;
  const top = h * 0.36;
  for (const offset of [-0.42, 0.42]) {
    const x = cx + offset * scale;
    ctx.beginPath();
    ctx.ellipse(x, top + scale * 0.32, scale * 0.2, scale * 0.24, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - scale * 0.5, h);
    ctx.bezierCurveTo(x - scale * 0.52, top + scale * 0.9, x - scale * 0.2, top + scale * 0.55, x, top + scale * 0.56);
    ctx.bezierCurveTo(x + scale * 0.2, top + scale * 0.55, x + scale * 0.52, top + scale * 0.9, x + scale * 0.5, h);
    ctx.fill();
  }
  ctx.restore();
  glow(ctx, cx, top + scale * 0.2, scale * 1.4, colors[3]!, 0.25);
}

function arches(ctx: Ctx, w: number, h: number, rng: Rng, colors: string[]) {
  const wall = mix(colors[3]!, "#f3e3cf", 0.55);
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, w, h);
  const count = w > h ? 3 : 2;
  const gap = w / count;
  const archWidth = gap * 0.62;
  const top = h * 0.2;
  const bottom = h * 0.86;
  for (let index = 0; index < count; index++) {
    const x = gap * index + (gap - archWidth) / 2;
    const inner = ctx.createLinearGradient(0, top, 0, bottom);
    inner.addColorStop(0, mix(colors[1]!, "#000000", 0.2));
    inner.addColorStop(0.6, colors[2]!);
    inner.addColorStop(1, mix(colors[4]!, wall, 0.3));
    ctx.fillStyle = inner;
    ctx.beginPath();
    ctx.moveTo(x, bottom);
    ctx.lineTo(x, top + archWidth / 2);
    ctx.arc(x + archWidth / 2, top + archWidth / 2, archWidth / 2, Math.PI, 0);
    ctx.lineTo(x + archWidth, bottom);
    ctx.closePath();
    ctx.fill();
    glow(ctx, x + archWidth / 2, bottom - (bottom - top) * 0.25, archWidth * 0.9, colors[4]!, 0.35);
  }
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  const shade = ctx.createLinearGradient(0, 0, w, h);
  const angle = rng();
  shade.addColorStop(0, "rgba(90,50,40,0.05)");
  shade.addColorStop(Math.max(0.05, angle * 0.6), "rgba(90,50,40,0.05)");
  shade.addColorStop(Math.min(0.95, angle * 0.6 + 0.15), "rgba(70,35,30,0.45)");
  shade.addColorStop(1, "rgba(50,25,25,0.55)");
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  const floor = ctx.createLinearGradient(0, bottom, 0, h);
  floor.addColorStop(0, mix(colors[2]!, "#6b3a2a", 0.5));
  floor.addColorStop(1, mix(colors[0]!, "#000000", 0.4));
  ctx.fillStyle = floor;
  ctx.fillRect(0, bottom, w, h - bottom);
  ctx.fillStyle = "rgba(20,12,14,0.85)";
  const person = gap * Math.floor(rng() * count) + gap / 2;
  const size = (bottom - top) * 0.32;
  ctx.beginPath();
  ctx.ellipse(person, bottom - size * 1.05, size * 0.09, size * 0.11, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(person - size * 0.22, bottom);
  ctx.quadraticCurveTo(person - size * 0.16, bottom - size * 0.85, person, bottom - size * 0.9);
  ctx.quadraticCurveTo(person + size * 0.16, bottom - size * 0.85, person + size * 0.22, bottom);
  ctx.fill();
}

const SCENES: Record<string, (ctx: Ctx, w: number, h: number, rng: Rng, colors: string[]) => void> = {
  coast,
  peaks,
  lagoon,
  dunes,
  bokeh,
  arches,
};

function finish(ctx: Ctx, w: number, h: number, rng: Rng) {
  const vignette = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.6);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.42)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);
  const image = ctx.getImageData(0, 0, w, h);
  const data = image.data;
  for (let index = 0; index < data.length; index += 4) {
    const grain = (rng() - 0.5) * 14;
    data[index] = data[index]! + grain;
    data[index + 1] = data[index + 1]! + grain;
    data[index + 2] = data[index + 2]! + grain;
  }
  ctx.putImageData(image, 0, 0);
}

export function drawScene(recipe: string, width: number, height: number): HTMLCanvasElement {
  const [kind = "coast", seedText = "1"] = recipe.split(":");
  const seed = hash(kind) ^ Math.imul(Number(seedText) || 1, 2654435761);
  const rng = random(seed);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const colors = SKIES[Math.floor(rng() * SKIES.length)]!;
  (SCENES[kind] ?? coast)(ctx, canvas.width, canvas.height, rng, colors);
  finish(ctx, canvas.width, canvas.height, rng);
  return canvas;
}

const sceneUrls = new Map<string, Promise<string>>();

export function sceneUrl(recipe: string, width: number, height: number, longEdge: number): Promise<string> {
  const scale = Math.min(1, longEdge / Math.max(width, height));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const key = `${recipe}@${w}x${h}`;
  let url = sceneUrls.get(key);
  if (!url) {
    url = new Promise<string>((resolve, reject) =>
      drawScene(recipe, w, h).toBlob(
        (blob) => (blob ? resolve(URL.createObjectURL(blob)) : reject(new Error("The preview couldn't be drawn."))),
        "image/png",
      ),
    );
    sceneUrls.set(key, url);
  }
  return url;
}

export async function samplePhoto(index: number): Promise<File> {
  const kinds = Object.keys(SCENES);
  const kind = kinds[index % kinds.length]!;
  const portrait = index % 3 === 1;
  const canvas = drawScene(`${kind}:${100 + index}`, portrait ? 1600 : 2400, portrait ? 2400 : 1600);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("The sample couldn't be drawn."))), "image/jpeg", 0.92),
  );
  const name = `SAMPLE_${String(index + 1).padStart(4, "0")}.jpg`;
  return new File([blob], name, { type: "image/jpeg" });
}
