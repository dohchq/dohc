type Rng = () => number;
type Ctx = CanvasRenderingContext2D;

const PLASTER = ["#f2dcc0", "#f4e6cf", "#efc9a8", "#f6d9a6", "#e9b89c", "#f3ece0", "#e7c3a8", "#f1d3b4", "#ead7c2", "#f5e2b8"];

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

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)) as [number, number, number];
}

function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = channels(a);
  const [r2, g2, b2] = channels(b);
  const lerp = (x: number, y: number) =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${lerp(r1, r2)}${lerp(g1, g2)}${lerp(b1, b2)}`;
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = channels(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

const between = (rng: Rng, low: number, high: number) => low + (high - low) * rng();
const choose = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)]!;

let density = 1;

function layer(w: number, h: number, draw: (ctx: Ctx) => void): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * density));
  canvas.height = Math.max(1, Math.round(h * density));
  const ctx = canvas.getContext("2d")!;
  ctx.scale(density, density);
  draw(ctx);
  return canvas;
}

function place(ctx: Ctx, source: HTMLCanvasElement) {
  ctx.drawImage(source, 0, 0, source.width / density, source.height / density);
}

function stamp(ctx: Ctx, source: HTMLCanvasElement, blur: number, alpha = 1, mode: GlobalCompositeOperation = "source-over") {
  ctx.save();
  if (blur > 0) ctx.filter = `blur(${blur * density}px)`;
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = mode;
  place(ctx, source);
  ctx.restore();
}

function vertical(ctx: Ctx, top: number, bottom: number, stops: readonly string[]) {
  const gradient = ctx.createLinearGradient(0, top, 0, bottom);
  stops.forEach((color, index) => gradient.addColorStop(index / Math.max(1, stops.length - 1), color));
  return gradient;
}

function glow(ctx: Ctx, x: number, y: number, radius: number, color: string, alpha: number, mode: GlobalCompositeOperation = "lighter") {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, rgba(color, alpha));
  gradient.addColorStop(0.4, rgba(color, alpha * 0.35));
  gradient.addColorStop(1, rgba(color, 0));
  ctx.save();
  ctx.globalCompositeOperation = mode;
  ctx.fillStyle = gradient;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  ctx.restore();
}

function oval(ctx: Ctx, x: number, y: number, rx: number, ry: number, fill: string | CanvasGradient, rotation = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rotation, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

function ridge(rng: Rng, w: number, base: number, rough: number, points = 9): Array<[number, number]> {
  let line: Array<[number, number]> = [
    [0, base + (rng() - 0.5) * rough],
    [w, base + (rng() - 0.5) * rough],
  ];
  let spread = rough;
  for (let pass = 0; pass < points; pass++) {
    const next: Array<[number, number]> = [];
    for (let index = 0; index < line.length - 1; index++) {
      const [x1, y1] = line[index]!;
      const [x2, y2] = line[index + 1]!;
      next.push([x1, y1], [(x1 + x2) / 2, (y1 + y2) / 2 + (rng() - 0.5) * spread]);
    }
    next.push(line[line.length - 1]!);
    line = next;
    spread *= 0.55;
  }
  return line;
}

function fillBelow(ctx: Ctx, line: Array<[number, number]>, bottom: number, fill: string | CanvasGradient) {
  ctx.beginPath();
  ctx.moveTo(line[0]![0], bottom);
  for (const [x, y] of line) ctx.lineTo(x, y);
  ctx.lineTo(line[line.length - 1]![0], bottom);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function speckle(ctx: Ctx, w: number, h: number, rng: Rng, count: number, colors: readonly string[], alpha: number, size: number) {
  for (let index = 0; index < count; index++) {
    ctx.fillStyle = rgba(choose(rng, colors), alpha * between(rng, 0.4, 1));
    const s = size * between(rng, 0.4, 1.4);
    ctx.fillRect(rng() * w, rng() * h, s, s);
  }
}

function sea(ctx: Ctx, w: number, top: number, bottom: number, rng: Rng, deep: string, near: string, sunX: number, glint: string) {
  ctx.fillStyle = vertical(ctx, top, bottom, [mix(deep, "#cfd8dc", 0.25), deep, near]);
  ctx.fillRect(0, top, w, bottom - top);
  const span = bottom - top;
  for (let index = 0; index < span * 1.6; index++) {
    const t = rng();
    const y = top + t * t * span;
    const length = w * between(rng, 0.004, 0.03) * (0.4 + t);
    const nearSun = Math.exp(-(((rng() - 0.5) * w * 0.8) ** 2) / (w * w * 0.02));
    const x = sunX + (rng() - 0.5) * w * (0.15 + t * 0.6);
    ctx.fillStyle = rgba(glint, (0.05 + nearSun * 0.35) * (1 - t * 0.5));
    ctx.fillRect(x, y, length, Math.max(1, span * 0.002 * (1 + t * 2)));
  }
  for (let index = 0; index < span * 0.8; index++) {
    const t = rng();
    const y = top + t * span;
    ctx.fillStyle = rgba("#0b2233", 0.05 + t * 0.08);
    ctx.fillRect(rng() * w, y, w * between(rng, 0.01, 0.05) * (0.3 + t), Math.max(1, span * 0.003 * (0.5 + t * 2)));
  }
}

function house(ctx: Ctx, x: number, y: number, bw: number, bh: number, color: string, haze: string, depth: number, rng: Rng) {
  const tint = mix(color, haze, depth * 0.55);
  const shade = mix(mix(color, "#5b4652", 0.38), haze, depth * 0.5);
  ctx.fillStyle = rgba("#2a2026", 0.22 * (1 - depth));
  ctx.fillRect(x + bw * 0.08, y + bh, bw, bh * 0.22);
  ctx.fillStyle = tint;
  ctx.fillRect(x, y, bw, bh);
  ctx.fillStyle = shade;
  ctx.fillRect(x + bw * 0.72, y, bw * 0.28, bh);
  ctx.fillStyle = mix(tint, "#ffffff", 0.25);
  ctx.fillRect(x, y, bw * 0.72, Math.max(1, bh * 0.06));
  if (bw < 3) return;
  const rows = bh > bw * 0.9 ? 2 : 1;
  const cols = Math.max(1, Math.round(bw / (bh * 0.5)));
  const window = mix(mix(color, "#271d22", 0.68), haze, depth * 0.45);
  const shutter = mix(choose(rng, ["#4d6b5c", "#3f5c75", "#6b5a3e", "#4b6b67"]), haze, depth * 0.5);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (rng() < 0.18) continue;
      const wx = x + bw * ((col + 0.5) / cols) - bw * 0.07;
      const wy = y + bh * (0.22 + row * 0.42);
      const ww = Math.max(1, bw * 0.13);
      const wh = Math.max(1, bh * 0.2);
      ctx.fillStyle = rng() < 0.35 ? shutter : window;
      ctx.fillRect(wx, wy, ww, wh);
    }
  }
  if (rng() < 0.25 && bh > 6) {
    ctx.fillStyle = mix(mix(color, "#2a1f24", 0.55), haze, depth * 0.45);
    ctx.beginPath();
    ctx.moveTo(x + bw * 0.1, y + bh);
    ctx.lineTo(x + bw * 0.1, y + bh * 0.62);
    ctx.arc(x + bw * 0.22, y + bh * 0.62, bw * 0.12, Math.PI, 0);
    ctx.lineTo(x + bw * 0.34, y + bh);
    ctx.fill();
  }
}

function village(ctx: Ctx, w: number, h: number, rng: Rng) {
  const blueHour = rng() < 0.3;
  const skyStops = blueHour
    ? ["#5f7aa1", "#9aa9c2", "#d6b6b0", "#efc4a2"]
    : ["#8aa9c4", "#c3cdd2", "#ead6b9", "#f4c695"];
  const horizon = h * between(rng, 0.22, 0.34);
  ctx.fillStyle = vertical(ctx, 0, horizon * 1.6, skyStops);
  ctx.fillRect(0, 0, w, h);
  const sunX = w * between(rng, 0.62, 0.92);
  glow(ctx, sunX, horizon * 0.7, w * 0.6, blueHour ? "#f0b59a" : "#ffd29a", 0.45);
  const haze = blueHour ? "#a7acc0" : "#e6d3bf";
  const far = layer(w, h, (c) => {
    fillBelow(c, ridge(rng, w, horizon, h * 0.12), h, mix("#7b8796", haze, 0.55));
  });
  stamp(ctx, far, w * 0.0015);
  const mid = layer(w, h, (c) => {
    fillBelow(c, ridge(rng, w, horizon + h * 0.07, h * 0.16), h, mix("#59604c", haze, 0.3));
  });
  stamp(ctx, mid, w * 0.0008);
  const shore = h * between(rng, 0.84, 0.9);
  const slopeTop = horizon + h * 0.1;
  ctx.fillStyle = vertical(ctx, slopeTop, shore, [mix("#5d5f45", haze, 0.25), "#4f4a36"]);
  ctx.fillRect(0, slopeTop, w, shore - slopeTop);
  ctx.save();
  ctx.translate(0, slopeTop);
  speckle(ctx, w, shore - slopeTop, rng, Math.round(w * 3), ["#3b4a2c", "#6b6a45", "#2f3a24"], 0.35, w * 0.006);
  ctx.restore();
  const bowl = between(rng, 0.35, 0.65);
  let y = slopeTop;
  while (y < shore - h * 0.01) {
    const t = (y - slopeTop) / (shore - slopeTop);
    const size = w * (0.012 + t * t * 0.05);
    const edge = 0.25 + t * 0.55;
    let x = -size * rng();
    while (x < w) {
      const fromBowl = Math.abs(x / w - bowl);
      const density = fromBowl < edge ? 0.94 : 0.4;
      const bw = size * between(rng, 0.9, 1.9);
      if (rng() < density) {
        house(ctx, x, y + (rng() - 0.5) * size * 0.3, bw, size * between(rng, 0.7, 1.15), choose(rng, PLASTER), haze, 1 - t, rng);
      } else {
        oval(ctx, x + bw / 2, y + size * 0.5, bw * 0.6, size * 0.55, mix(choose(rng, ["#3c4a2e", "#4b5634", "#2f3d27"]), haze, (1 - t) * 0.4));
      }
      if (rng() < 0.05) {
        const cx = x + bw / 2;
        ctx.fillStyle = mix("#1f2c1c", haze, (1 - t) * 0.4);
        ctx.beginPath();
        ctx.ellipse(cx, y - size * 0.6, size * 0.16, size * 1.1, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      x += bw * between(rng, 0.92, 1.12);
    }
    y += size * between(rng, 0.62, 0.78);
  }
  const domeX = w * (bowl + (rng() - 0.5) * 0.2);
  const domeY = slopeTop + (shore - slopeTop) * between(rng, 0.55, 0.7);
  const domeR = w * 0.03;
  ctx.fillStyle = "#e9dcc6";
  ctx.fillRect(domeX - domeR * 1.1, domeY, domeR * 2.2, domeR * 1.3);
  ctx.fillStyle = "#c7b597";
  ctx.fillRect(domeX + domeR * 0.5, domeY, domeR * 0.6, domeR * 1.3);
  const tiles = ctx.createLinearGradient(domeX - domeR, 0, domeX + domeR, 0);
  tiles.addColorStop(0, "#3f8a72");
  tiles.addColorStop(0.45, "#6fb08a");
  tiles.addColorStop(1, "#2a5a4d");
  ctx.beginPath();
  ctx.arc(domeX, domeY, domeR, Math.PI, 0);
  ctx.fillStyle = tiles;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = "rgba(240,205,90,0.75)";
  ctx.lineWidth = Math.max(1, domeR * 0.08);
  for (let ray = -4; ray <= 4; ray++) {
    ctx.beginPath();
    ctx.moveTo(domeX, domeY - domeR);
    ctx.lineTo(domeX + ray * domeR * 0.32, domeY);
    ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = "#efe4cf";
  ctx.fillRect(domeX - domeR * 0.12, domeY - domeR * 1.35, domeR * 0.24, domeR * 0.4);
  ctx.fillStyle = vertical(ctx, shore - h * 0.012, shore + h * 0.01, ["#cdb38c", "#a98d68"]);
  ctx.fillRect(0, shore - h * 0.012, w, h * 0.022);
  for (let index = 0; index < w * 0.08; index++) {
    const ux = rng() * w;
    oval(ctx, ux, shore - h * 0.004, w * 0.004, w * 0.0016, choose(rng, ["#e9763d", "#f0e8d8", "#2f8a86"]));
  }
  sea(ctx, w, shore + h * 0.008, h, rng, "#24607e", "#123c56", sunX, "#ffe2b0");
  for (let index = 0; index < 6 + rng() * 6; index++) {
    const bx = rng() * w;
    const by = shore + h * 0.02 + rng() * (h - shore) * 0.8;
    const bl = w * between(rng, 0.008, 0.02);
    oval(ctx, bx + bl * 0.1, by + bl * 0.12, bl * 0.55, bl * 0.14, "rgba(5,20,30,0.35)");
    oval(ctx, bx, by, bl * 0.5, bl * 0.16, "#f4f1ea");
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fillRect(bx - bl * 1.6, by, bl * 1.1, Math.max(1, bl * 0.06));
  }
  ctx.save();
  ctx.globalCompositeOperation = "soft-light";
  const light = ctx.createLinearGradient(sunX, 0, w - sunX, h);
  light.addColorStop(0, "rgba(255,196,120,0.55)");
  light.addColorStop(1, "rgba(40,50,90,0.35)");
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

function umbrella(ctx: Ctx, x: number, y: number, r: number, colors: readonly [string, string], rng: Rng) {
  const segments = 8;
  const turn = rng() * Math.PI;
  for (let index = 0; index < segments; index++) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, r, turn + (index / segments) * Math.PI * 2, turn + ((index + 1) / segments) * Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = colors[index % 2]!;
    ctx.fill();
  }
  const shade = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r * 1.05);
  shade.addColorStop(0, "rgba(255,255,255,0.28)");
  shade.addColorStop(0.6, "rgba(255,255,255,0)");
  shade.addColorStop(1, "rgba(40,20,10,0.28)");
  oval(ctx, x, y, r, r, shade);
  ctx.strokeStyle = "rgba(60,40,30,0.25)";
  ctx.lineWidth = Math.max(0.6, r * 0.03);
  for (let index = 0; index < segments; index++) {
    const angle = turn + (index / segments) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * r, y + Math.sin(angle) * r);
    ctx.stroke();
  }
  oval(ctx, x, y, r * 0.09, r * 0.09, "#f6f2ea");
}

function beach(ctx: Ctx, w: number, h: number, rng: Rng) {
  const landscape = w >= h;
  const long = landscape ? w : h;
  const short = landscape ? h : w;
  ctx.save();
  if (!landscape) {
    ctx.translate(w, 0);
    ctx.rotate(Math.PI / 2);
  }
  const shoreAt = (t: number) => short * (0.46 + 0.05 * Math.sin(t * 5.2 + 1) + 0.025 * Math.sin(t * 13));
  ctx.fillStyle = vertical(ctx, 0, short, ["#d9c3a0", "#e3cfae", "#d6bd96"]);
  ctx.fillRect(0, 0, long, short);
  speckle(ctx, long, short, rng, Math.round(long * 6), ["#b49a76", "#f2e4c8", "#a68b66"], 0.18, long * 0.0018);
  const water = ctx.createLinearGradient(0, short * 0.4, 0, short);
  water.addColorStop(0, "#8fe0d2");
  water.addColorStop(0.18, "#4cc0bd");
  water.addColorStop(0.5, "#1f8fa8");
  water.addColorStop(1, "#0f5f83");
  ctx.beginPath();
  ctx.moveTo(0, short);
  for (let x = 0; x <= long; x += long / 120) ctx.lineTo(x, shoreAt(x / long));
  ctx.lineTo(long, short);
  ctx.closePath();
  ctx.fillStyle = water;
  ctx.fill();
  const wet = layer(long, short, (c) => {
    c.strokeStyle = "rgba(150,120,85,0.55)";
    c.lineWidth = short * 0.03;
    c.beginPath();
    for (let x = 0; x <= long; x += long / 120) c.lineTo(x, shoreAt(x / long) - short * 0.012);
    c.stroke();
  });
  stamp(ctx, wet, short * 0.01);
  const foam = layer(long, short, (c) => {
    for (let band = 0; band < 4; band++) {
      c.strokeStyle = `rgba(255,255,255,${0.75 - band * 0.16})`;
      c.lineWidth = short * (0.008 - band * 0.0012);
      c.beginPath();
      for (let x = 0; x <= long; x += long / 240) {
        c.lineTo(x, shoreAt(x / long) + band * short * 0.022 + Math.sin(x * 0.05 + band) * short * 0.004);
      }
      c.stroke();
    }
  });
  stamp(ctx, foam, short * 0.002);
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = Math.max(1, short * 0.002);
  for (let index = 0; index < long * 0.12; index++) {
    const x = rng() * long;
    const top = shoreAt(x / long) + short * 0.05;
    const y = top + rng() * (short - top);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + short * 0.02, y - short * 0.006, x + short * between(rng, 0.03, 0.07), y);
    ctx.stroke();
  }
  const schemes: ReadonlyArray<readonly [string, string]> = [
    ["#e46c38", "#f6efe3"],
    ["#2a8c8a", "#f4efe4"],
    ["#f1bd45", "#f8f2e4"],
    ["#1f4f7a", "#f4efe5"],
  ];
  const scheme = choose(rng, schemes);
  const r = short * 0.032;
  const gap = r * 3;
  const spots: Array<[number, number, number]> = [];
  for (let row = 0; row < 4; row++) {
    for (let x = gap * 0.8 + (row % 2) * gap * 0.5; x < long - r; x += gap) {
      const y = shoreAt(x / long) - short * 0.07 - row * gap * 0.9;
      if (y > r) spots.push([x, y, r * between(rng, 0.92, 1.05)]);
    }
  }
  const shadows = layer(long, short, (c) => {
    for (const [x, y, size] of spots) {
      oval(c, x + size * 0.55, y + size * 0.42, size * 1.02, size * 0.98, "rgba(70,48,24,0.5)");
      c.fillStyle = "rgba(90,60,35,0.35)";
      c.fillRect(x + size * 0.95, y - size * 0.55, size * 0.5, size * 1.4);
      c.fillRect(x - size * 1.1, y - size * 0.55, size * 0.5, size * 1.4);
    }
  });
  stamp(ctx, shadows, r * 0.12);
  for (const [x, y, size] of spots) {
    ctx.fillStyle = "#f6f3ec";
    ctx.fillRect(x + size * 0.8, y - size * 0.7, size * 0.42, size * 1.3);
    ctx.fillRect(x - size * 1.25, y - size * 0.7, size * 0.42, size * 1.3);
    if (rng() < 0.4) oval(ctx, x + size * 1.02, y - size * 0.4, size * 0.14, size * 0.14, "#c58f6e");
    umbrella(ctx, x, y, size, rng() < 0.9 ? scheme : choose(rng, schemes), rng);
  }
  for (let index = 0; index < long * 0.012; index++) {
    const x = rng() * long;
    const top = shoreAt(x / long) + short * 0.03;
    const y = top + rng() * short * 0.12;
    oval(ctx, x + r * 0.15, y + r * 0.1, r * 0.16, r * 0.1, "rgba(10,60,80,0.35)");
    oval(ctx, x, y, r * 0.12, r * 0.12, "#d6a07e");
  }
  ctx.restore();
}

function boat(ctx: Ctx, w: number, h: number, rng: Rng) {
  const water = ctx.createLinearGradient(0, 0, w, h);
  water.addColorStop(0, "#5cc6c1");
  water.addColorStop(0.45, "#1d97a8");
  water.addColorStop(1, "#0d5f7f");
  ctx.fillStyle = water;
  ctx.fillRect(0, 0, w, h);
  const bed = layer(w, h, (c) => {
    for (let index = 0; index < 30; index++) {
      oval(c, rng() * w, rng() * h, w * between(rng, 0.05, 0.18), h * between(rng, 0.03, 0.12), rng() < 0.6 ? "rgba(230,240,220,0.22)" : "rgba(6,40,60,0.25)", rng() * Math.PI);
    }
  });
  stamp(ctx, bed, w * 0.02);
  const caustics = layer(w, h, (c) => {
    c.strokeStyle = "rgba(220,255,250,0.22)";
    for (let index = 0; index < (w * h) / 2600; index++) {
      const x = rng() * w;
      const y = rng() * h;
      const s = w * between(rng, 0.006, 0.02);
      c.lineWidth = Math.max(0.6, w * 0.0012);
      c.beginPath();
      c.moveTo(x, y);
      c.bezierCurveTo(x + s, y - s * 0.6, x + s * 1.5, y + s * 0.7, x + s * 2.4, y + (rng() - 0.5) * s);
      c.stroke();
    }
  });
  stamp(ctx, caustics, w * 0.0009, 0.9, "screen");
  const angle = between(rng, -0.7, 0.7) + (rng() < 0.5 ? Math.PI : 0);
  const cx = w * between(rng, 0.38, 0.62);
  const cy = h * between(rng, 0.38, 0.62);
  const length = Math.min(w, h) * between(rng, 0.32, 0.42);
  const breadth = length * 0.33;
  const hull = (c: Ctx) => {
    c.beginPath();
    c.moveTo(length * 0.55, 0);
    c.bezierCurveTo(length * 0.35, -breadth * 0.55, -length * 0.2, -breadth * 0.52, -length * 0.45, -breadth * 0.42);
    c.lineTo(-length * 0.45, breadth * 0.42);
    c.bezierCurveTo(-length * 0.2, breadth * 0.52, length * 0.35, breadth * 0.55, length * 0.55, 0);
    c.closePath();
  };
  const wake = layer(w, h, (c) => {
    c.translate(cx, cy);
    c.rotate(angle);
    for (let index = 0; index < 260; index++) {
      const t = rng();
      const spread = t * length * 1.6;
      const side = rng() < 0.5 ? -1 : 1;
      const x = -length * 0.45 - t * length * 3.2;
      const y = side * (breadth * 0.3 + spread * 0.42) + (rng() - 0.5) * length * 0.05;
      oval(c, x, y, length * between(rng, 0.01, 0.05), length * 0.008, `rgba(255,255,255,${0.55 * (1 - t)})`, (rng() - 0.5) * 0.4);
    }
    const trail = c.createLinearGradient(-length * 0.45, 0, -length * 2.6, 0);
    trail.addColorStop(0, "rgba(255,255,255,0.55)");
    trail.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = trail;
    c.beginPath();
    c.moveTo(-length * 0.45, -breadth * 0.3);
    c.quadraticCurveTo(-length * 1.4, -breadth * 0.12, -length * 2.6, -breadth * 0.3);
    c.lineTo(-length * 2.6, breadth * 0.3);
    c.quadraticCurveTo(-length * 1.4, breadth * 0.12, -length * 0.45, breadth * 0.3);
    c.closePath();
    c.fill();
  });
  stamp(ctx, wake, w * 0.003);
  const shadow = layer(w, h, (c) => {
    c.translate(cx + length * 0.12, cy + length * 0.16);
    c.rotate(angle);
    hull(c);
    c.fillStyle = "rgba(4,30,45,0.45)";
    c.fill();
  });
  stamp(ctx, shadow, length * 0.05);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  hull(ctx);
  const side = ctx.createLinearGradient(0, -breadth * 0.5, 0, breadth * 0.5);
  side.addColorStop(0, "#ffffff");
  side.addColorStop(0.5, "#eeebe6");
  side.addColorStop(1, "#b9b6b2");
  ctx.fillStyle = side;
  ctx.fill();
  ctx.save();
  ctx.scale(0.82, 0.74);
  hull(ctx);
  ctx.fillStyle = "#a8774d";
  ctx.fill();
  ctx.strokeStyle = "rgba(70,40,20,0.35)";
  ctx.lineWidth = Math.max(0.6, length * 0.004);
  for (let plank = -breadth * 0.4; plank < breadth * 0.4; plank += breadth * 0.08) {
    ctx.beginPath();
    ctx.moveTo(-length * 0.45, plank);
    ctx.lineTo(length * 0.4, plank * 0.6);
    ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = "#f3eee4";
  ctx.fillRect(-length * 0.36, -breadth * 0.3, length * 0.22, breadth * 0.6);
  ctx.fillStyle = "#26323a";
  ctx.beginPath();
  ctx.moveTo(length * 0.08, -breadth * 0.32);
  ctx.quadraticCurveTo(length * 0.2, 0, length * 0.08, breadth * 0.32);
  ctx.lineTo(length * 0.02, breadth * 0.3);
  ctx.quadraticCurveTo(length * 0.12, 0, length * 0.02, -breadth * 0.3);
  ctx.fill();
  if (rng() < 0.7) {
    oval(ctx, -length * 0.26, -breadth * 0.12, length * 0.05, length * 0.03, "#e8b07f");
    oval(ctx, -length * 0.22, breadth * 0.12, length * 0.05, length * 0.03, "#c98c66");
  }
  ctx.restore();
  for (let index = 0; index < 120; index++) {
    glow(ctx, rng() * w, rng() * h, w * 0.004, "#ffffff", 0.6);
  }
}

function arch(ctx: Ctx, x: number, top: number, width: number, bottom: number, fresh = true) {
  if (fresh) ctx.beginPath();
  ctx.moveTo(x, bottom);
  ctx.lineTo(x, top + width / 2);
  ctx.arc(x + width / 2, top + width / 2, width / 2, Math.PI, 0);
  ctx.lineTo(x + width, bottom);
  ctx.closePath();
}

function terrace(ctx: Ctx, w: number, h: number, rng: Rng) {
  const wall = choose(rng, ["#e8d3bb", "#efdcc5", "#e6cdb4", "#eedfcf"]);
  const floorTop = h * between(rng, 0.74, 0.8);
  ctx.fillStyle = vertical(ctx, 0, floorTop, [mix(wall, "#8a6f5c", 0.3), wall, mix(wall, "#b08e74", 0.2)]);
  ctx.fillRect(0, 0, w, floorTop);
  const blotch = layer(w, h, (c) => {
    for (let index = 0; index < 60; index++) {
      oval(c, rng() * w, rng() * floorTop, w * between(rng, 0.03, 0.12), h * between(rng, 0.02, 0.08), rng() < 0.5 ? "rgba(255,245,230,0.18)" : "rgba(120,90,70,0.12)");
    }
  });
  stamp(ctx, blotch, w * 0.02);
  speckle(ctx, w, floorTop, rng, Math.round(w * 4), ["#7c6252", "#fff6ea"], 0.08, w * 0.0016);
  const count = w > h ? 3 : 2;
  const margin = w * (count === 2 ? 0.1 : 0.06);
  const gap = w * 0.08;
  const width = (w - margin * 2 - gap * (count - 1)) / count;
  const top = h * (count === 2 ? 0.14 : 0.16);
  const bottom = floorTop - h * 0.06;
  const horizon = top + (bottom - top) * between(rng, 0.55, 0.68);
  const view = layer(w, h, (c) => {
    c.fillStyle = vertical(c, top, horizon, ["#9fc0d8", "#cfdbe0", "#f2dcc0"]);
    c.fillRect(0, 0, w, horizon);
    fillBelow(c, ridge(rng, w, horizon - h * 0.03, h * 0.05), horizon + 2, "#9aa7b0");
    sea(c, w, horizon, bottom, rng, "#3f7fa3", "#2a6a8c", w * 0.6, "#fff1d6");
    if (rng() < 0.6) {
      const sx = w * between(rng, 0.2, 0.8);
      c.fillStyle = "#f7f3ea";
      c.beginPath();
      c.moveTo(sx, horizon - h * 0.05);
      c.lineTo(sx + w * 0.018, horizon - h * 0.002);
      c.lineTo(sx - w * 0.004, horizon - h * 0.002);
      c.fill();
    }
  });
  ctx.save();
  ctx.beginPath();
  for (let index = 0; index < count; index++) {
    const x = margin + index * (width + gap);
    arch(ctx, x, top, width, bottom, false);
  }
  ctx.clip();
  place(ctx, view);
  ctx.restore();
  for (let index = 0; index < count; index++) {
    const x = margin + index * (width + gap);
    ctx.save();
    arch(ctx, x, top, width, bottom);
    ctx.clip();
    const reveal = ctx.createLinearGradient(x, 0, x + width * 0.14, 0);
    reveal.addColorStop(0, mix(wall, "#5a4436", 0.45));
    reveal.addColorStop(1, rgba(mix(wall, "#5a4436", 0.45), 0));
    ctx.fillStyle = reveal;
    ctx.fillRect(x, top, width * 0.14, bottom - top);
    ctx.restore();
  }
  const floor = vertical(ctx, floorTop, h, ["#a45d43", "#8d4c36"]);
  ctx.fillStyle = floor;
  ctx.fillRect(0, floorTop, w, h - floorTop);
  ctx.strokeStyle = "rgba(60,25,15,0.35)";
  ctx.lineWidth = Math.max(1, w * 0.0015);
  const vanishX = w * 0.5;
  for (let index = -12; index <= 12; index++) {
    ctx.beginPath();
    ctx.moveTo(vanishX + index * w * 0.04, floorTop);
    ctx.lineTo(vanishX + index * w * 0.2, h);
    ctx.stroke();
  }
  for (let row = 1; row < 8; row++) {
    const y = floorTop + (h - floorTop) * (row / 8) ** 1.6;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  const light = layer(w, h, (c) => {
    c.fillStyle = "rgba(255,214,160,0.9)";
    const skew = between(rng, 0.25, 0.55) * (rng() < 0.5 ? -1 : 1);
    for (let index = 0; index < count; index++) {
      const x = margin + index * (width + gap);
      c.beginPath();
      c.moveTo(x, floorTop);
      c.lineTo(x + width, floorTop);
      c.lineTo(x + width + skew * w * 0.4, h);
      c.lineTo(x + skew * w * 0.4, h);
      c.closePath();
      c.fill();
      c.fillStyle = "rgba(255,214,160,0.35)";
      c.save();
      c.translate(skew * w * 0.15, 0);
      arch(c, x + width * 0.08, top + (bottom - top) * 0.55, width * 0.84, floorTop);
      c.restore();
      c.fill();
      c.fillStyle = "rgba(255,214,160,0.9)";
    }
  });
  stamp(ctx, light, w * 0.006, 0.5, "soft-light");
  stamp(ctx, light, w * 0.012, 0.22, "screen");
  const potX = rng() < 0.5 ? w * 0.06 : w * 0.8;
  const potW = w * 0.13;
  const potTop = floorTop + h * 0.02;
  const potBottom = floorTop + h * 0.13;
  const shadowPot = layer(w, h, (c) => oval(c, potX + potW * 0.65, potBottom, potW * 0.7, h * 0.02, "rgba(40,20,10,0.6)"));
  stamp(ctx, shadowPot, w * 0.01);
  ctx.beginPath();
  ctx.moveTo(potX, potTop);
  ctx.lineTo(potX + potW, potTop);
  ctx.lineTo(potX + potW * 0.82, potBottom);
  ctx.lineTo(potX + potW * 0.18, potBottom);
  ctx.closePath();
  const pot = ctx.createLinearGradient(potX, 0, potX + potW, 0);
  pot.addColorStop(0, "#c2704c");
  pot.addColorStop(0.5, "#b0603f");
  pot.addColorStop(1, "#7a3e27");
  ctx.fillStyle = pot;
  ctx.fill();
  const leaves = layer(w, h, (c) => {
    for (let index = 0; index < 220; index++) {
      const angle = rng() * Math.PI * 2;
      const radius = potW * Math.sqrt(rng()) * 0.95;
      const lx = potX + potW / 2 + Math.cos(angle) * radius;
      const ly = potTop - potW * 0.9 + Math.sin(angle) * radius * 1.1;
      oval(c, lx, ly, potW * 0.07, potW * 0.03, choose(rng, ["#33502b", "#466b34", "#5b8442", "#2a4223"]), rng() * Math.PI);
    }
    for (let index = 0; index < 9; index++) {
      const angle = rng() * Math.PI * 2;
      const radius = potW * Math.sqrt(rng()) * 0.8;
      oval(c, potX + potW / 2 + Math.cos(angle) * radius, potTop - potW * 0.9 + Math.sin(angle) * radius, potW * 0.05, potW * 0.035, "#f0c934");
    }
    c.fillStyle = "#4b3424";
    c.fillRect(potX + potW * 0.47, potTop - potW * 0.25, potW * 0.06, potW * 0.28);
  });
  stamp(ctx, leaves, 0);
  if (rng() < 0.7) {
    const index = Math.floor(rng() * count);
    const px = margin + index * (width + gap) + width * between(rng, 0.35, 0.6);
    const size = (bottom - top) * 0.36;
    const figure = layer(w, h, (c) => {
      c.fillStyle = "#3a2a28";
      oval(c, px, bottom - size * 1.02, size * 0.07, size * 0.085, "#3a2a28");
      c.beginPath();
      c.moveTo(px - size * 0.08, bottom - size * 0.9);
      c.quadraticCurveTo(px - size * 0.2, bottom - size * 0.4, px - size * 0.24, bottom);
      c.lineTo(px + size * 0.22, bottom);
      c.quadraticCurveTo(px + size * 0.18, bottom - size * 0.4, px + size * 0.08, bottom - size * 0.9);
      c.closePath();
      c.fillStyle = "#efe7dc";
      c.fill();
    });
    stamp(ctx, figure, w * 0.0012);
  }
  const vignette = ctx.createRadialGradient(w / 2, h * 0.45, Math.min(w, h) * 0.3, w / 2, h * 0.45, Math.hypot(w, h) * 0.62);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(60,35,20,0.35)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);
}

function lemon(ctx: Ctx, x: number, y: number, r: number, rotation: number, rng: Rng) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  const shape = () => {
    ctx.beginPath();
    ctx.moveTo(-r * 1.32, 0);
    ctx.bezierCurveTo(-r * 1.1, -r * 0.2, -r * 0.9, -r * 0.92, 0, -r * 0.9);
    ctx.bezierCurveTo(r * 0.9, -r * 0.92, r * 1.1, -r * 0.2, r * 1.32, 0);
    ctx.bezierCurveTo(r * 1.1, r * 0.2, r * 0.9, r * 0.92, 0, r * 0.9);
    ctx.bezierCurveTo(-r * 0.9, r * 0.92, -r * 1.1, r * 0.2, -r * 1.32, 0);
    ctx.closePath();
  };
  shape();
  const body = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r * 1.3);
  body.addColorStop(0, "#fff3a3");
  body.addColorStop(0.35, "#f6d63a");
  body.addColorStop(0.8, "#e1ad16");
  body.addColorStop(1, "#a9740d");
  ctx.fillStyle = body;
  ctx.fill();
  ctx.save();
  ctx.clip();
  for (let index = 0; index < r * 6; index++) {
    ctx.fillStyle = rng() < 0.5 ? "rgba(150,100,0,0.12)" : "rgba(255,255,220,0.18)";
    ctx.fillRect((rng() - 0.5) * r * 2.6, (rng() - 0.5) * r * 1.8, Math.max(1, r * 0.03), Math.max(1, r * 0.03));
  }
  ctx.restore();
  glow(ctx, -r * 0.45, -r * 0.45, r * 0.35, "#ffffff", 0.55, "screen");
  ctx.restore();
}

function lemons(ctx: Ctx, w: number, h: number, rng: Rng) {
  const cloth = choose(rng, ["#f1eee8", "#ece7dd", "#e8edf0"]);
  ctx.fillStyle = cloth;
  ctx.fillRect(0, 0, w, h);
  const stripes = choose(rng, ["#2f5f93", "#2a6f86", "#a9473a"]);
  ctx.fillStyle = rgba(stripes, 0.85);
  const stripe = w * 0.03;
  for (let x = -stripe; x < w + stripe; x += stripe * 4) {
    ctx.fillRect(x, 0, stripe, h);
    ctx.fillRect(x + stripe * 1.5, 0, stripe * 0.3, h);
  }
  const folds = layer(w, h, (c) => {
    for (let index = 0; index < 8; index++) {
      const y = rng() * h;
      c.fillStyle = vertical(c, y - h * 0.05, y + h * 0.05, ["rgba(0,0,0,0)", "rgba(40,40,60,0.18)", "rgba(255,255,255,0.25)", "rgba(0,0,0,0)"]);
      c.fillRect(0, y - h * 0.05, w, h * 0.1);
    }
  });
  stamp(ctx, folds, w * 0.01);
  ctx.strokeStyle = "rgba(90,80,70,0.05)";
  ctx.lineWidth = 1;
  for (let y = 0; y < h; y += Math.max(2, h / 400)) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y + (rng() - 0.5) * 2);
    ctx.stroke();
  }
  const unit = Math.min(w, h);
  const plateX = w * between(rng, 0.42, 0.58);
  const plateY = h * between(rng, 0.45, 0.58);
  const plateR = unit * 0.36;
  const plateShadow = layer(w, h, (c) => oval(c, plateX + unit * 0.04, plateY + unit * 0.05, plateR, plateR * 0.86, "rgba(40,35,45,0.5)"));
  stamp(ctx, plateShadow, unit * 0.03);
  oval(ctx, plateX, plateY, plateR, plateR * 0.86, "#f5f1e8");
  ctx.strokeStyle = "#2b5c9e";
  ctx.lineWidth = unit * 0.012;
  ctx.beginPath();
  ctx.ellipse(plateX, plateY, plateR * 0.9, plateR * 0.775, 0, 0, Math.PI * 2);
  ctx.stroke();
  for (let index = 0; index < 18; index++) {
    const angle = (index / 18) * Math.PI * 2;
    const px = plateX + Math.cos(angle) * plateR * 0.8;
    const py = plateY + Math.sin(angle) * plateR * 0.69;
    oval(ctx, px, py, unit * 0.022, unit * 0.01, index % 2 ? "#e2b23a" : "#3d7a4c", angle);
  }
  oval(ctx, plateX, plateY, plateR * 0.68, plateR * 0.58, "#f8f4ec");
  const glaze = ctx.createRadialGradient(plateX - plateR * 0.4, plateY - plateR * 0.4, 0, plateX, plateY, plateR);
  glaze.addColorStop(0, "rgba(255,255,255,0.5)");
  glaze.addColorStop(1, "rgba(255,255,255,0)");
  oval(ctx, plateX, plateY, plateR, plateR * 0.86, glaze);
  const placed: Array<[number, number, number]> = [];
  for (let index = 0; index < 5 + Math.floor(rng() * 3); index++) {
    const inside = index < 4;
    const angle = rng() * Math.PI * 2;
    const distance = inside ? plateR * 0.4 * Math.sqrt(rng()) : plateR * between(rng, 1.05, 1.35);
    placed.push([plateX + Math.cos(angle) * distance, plateY + Math.sin(angle) * distance * 0.86, unit * between(rng, 0.075, 0.095)]);
  }
  placed.sort((a, b) => a[1] - b[1]);
  for (const [x, y, r] of placed) {
    const shadow = layer(w, h, (c) => oval(c, x + r * 0.35, y + r * 0.55, r * 1.25, r * 0.7, "rgba(50,40,30,0.55)"));
    stamp(ctx, shadow, r * 0.25);
    lemon(ctx, x, y, r, between(rng, -0.6, 0.6), rng);
  }
  const [lx, ly, lr] = placed[placed.length - 1]!;
  ctx.save();
  ctx.translate(lx - lr * 1.2, ly - lr * 0.6);
  ctx.rotate(-0.8);
  const leaf = ctx.createLinearGradient(0, -lr * 0.3, 0, lr * 0.3);
  leaf.addColorStop(0, "#5a8a3e");
  leaf.addColorStop(1, "#2f5223");
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(lr * 0.9, -lr * 0.55, lr * 1.9, 0);
  ctx.quadraticCurveTo(lr * 0.9, lr * 0.55, 0, 0);
  ctx.fillStyle = leaf;
  ctx.fill();
  ctx.strokeStyle = "rgba(210,230,170,0.6)";
  ctx.lineWidth = Math.max(1, lr * 0.03);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(lr * 1.8, 0);
  ctx.stroke();
  ctx.restore();
  const halfX = plateX + plateR * between(rng, -0.9, 0.9);
  const halfY = plateY + plateR * (rng() < 0.5 ? -1.15 : 1.1);
  const halfR = unit * 0.07;
  const halfShadow = layer(w, h, (c) => oval(c, halfX + halfR * 0.3, halfY + halfR * 0.4, halfR * 1.1, halfR * 0.9, "rgba(50,40,30,0.5)"));
  stamp(ctx, halfShadow, halfR * 0.2);
  oval(ctx, halfX, halfY, halfR, halfR * 0.92, "#e7b419");
  oval(ctx, halfX, halfY, halfR * 0.9, halfR * 0.82, "#fbf3c8");
  oval(ctx, halfX, halfY, halfR * 0.8, halfR * 0.72, "#f6dc63");
  ctx.strokeStyle = "rgba(255,250,220,0.9)";
  ctx.lineWidth = Math.max(1, halfR * 0.04);
  for (let index = 0; index < 10; index++) {
    const angle = (index / 10) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(halfX, halfY);
    ctx.lineTo(halfX + Math.cos(angle) * halfR * 0.8, halfY + Math.sin(angle) * halfR * 0.72);
    ctx.stroke();
  }
  ctx.save();
  ctx.globalCompositeOperation = "soft-light";
  const window = ctx.createLinearGradient(0, 0, w, h);
  window.addColorStop(0, "rgba(255,245,220,0.7)");
  window.addColorStop(1, "rgba(20,30,60,0.5)");
  ctx.fillStyle = window;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

function figure(c: Ctx, x: number, base: number, size: number, lean: number, long: boolean) {
  c.save();
  c.translate(x, base);
  c.rotate(lean);
  c.beginPath();
  c.ellipse(0, -size * 0.88, size * 0.085, size * 0.105, 0, 0, Math.PI * 2);
  c.fill();
  if (long) {
    c.beginPath();
    c.moveTo(-size * 0.08, -size * 0.92);
    c.quadraticCurveTo(-size * 0.16, -size * 0.72, -size * 0.11, -size * 0.6);
    c.lineTo(size * 0.06, -size * 0.7);
    c.closePath();
    c.fill();
  }
  c.beginPath();
  c.moveTo(-size * 0.035, -size * 0.8);
  c.lineTo(-size * 0.04, -size * 0.74);
  c.quadraticCurveTo(-size * 0.22, -size * 0.72, -size * 0.25, -size * 0.55);
  c.lineTo(-size * 0.3, 0);
  c.lineTo(size * 0.3, 0);
  c.lineTo(size * 0.25, -size * 0.55);
  c.quadraticCurveTo(size * 0.22, -size * 0.72, size * 0.04, -size * 0.74);
  c.lineTo(size * 0.035, -size * 0.8);
  c.closePath();
  c.fill();
  c.restore();
}

function couple(ctx: Ctx, w: number, h: number, rng: Rng) {
  const horizon = h * between(rng, 0.5, 0.6);
  const sunX = w * between(rng, 0.38, 0.62);
  const sunY = horizon - h * between(rng, 0.03, 0.08);
  const background = layer(w, h, (c) => {
    c.fillStyle = vertical(c, 0, horizon, ["#6f7fa0", "#c99a8e", "#f3b57d", "#ffd59b"]);
    c.fillRect(0, 0, w, horizon);
    sea(c, w, horizon, h, rng, "#7d6f7a", "#3c3445", sunX, "#ffd9a0");
    glow(c, sunX, sunY, w * 0.5, "#ffcf8a", 0.9);
    glow(c, sunX, sunY, w * 0.08, "#fff5dc", 1);
    fillBelow(c, ridge(rng, w, horizon - h * 0.015, h * 0.03), horizon + 1, "#8b6f73");
  });
  stamp(ctx, background, Math.min(w, h) * 0.02);
  for (let index = 0; index < 40; index++) {
    const t = rng();
    const bx = sunX + (rng() - 0.5) * w * 0.9;
    const by = horizon + t * (h - horizon) * 0.6;
    const r = Math.min(w, h) * between(rng, 0.012, 0.04);
    const disc = ctx.createRadialGradient(bx, by, 0, bx, by, r);
    disc.addColorStop(0, "rgba(255,226,170,0.18)");
    disc.addColorStop(0.85, "rgba(255,220,160,0.26)");
    disc.addColorStop(1, "rgba(255,220,160,0)");
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    oval(ctx, bx, by, r, r, disc);
    ctx.restore();
  }
  const grass = layer(w, h, (c) => {
    for (let index = 0; index < w * 0.6; index++) {
      const gx = rng() * w;
      const gh = h * between(rng, 0.08, 0.22);
      c.strokeStyle = rng() < 0.3 ? "rgba(255,206,140,0.7)" : "rgba(60,45,40,0.85)";
      c.lineWidth = Math.max(1, w * between(rng, 0.001, 0.003));
      c.beginPath();
      c.moveTo(gx, h);
      c.quadraticCurveTo(gx + (rng() - 0.5) * w * 0.03, h - gh * 0.6, gx + (rng() - 0.5) * w * 0.05, h - gh);
      c.stroke();
    }
  });
  stamp(ctx, grass, Math.min(w, h) * 0.006);
  const size = Math.min(h * between(rng, 0.46, 0.54), w * 0.9);
  const cx = sunX + w * (rng() < 0.5 ? -0.05 : 0.05);
  const rim = layer(w, h, (c) => {
    c.fillStyle = "#ffd59a";
    figure(c, cx - size * 0.14, h + size * 0.05, size, 0.08, true);
    figure(c, cx + size * 0.12, h + size * 0.08, size * 1.08, -0.06, false);
  });
  stamp(ctx, rim, Math.min(w, h) * 0.006, 1, "screen");
  const bodies = layer(w, h, (c) => {
    c.fillStyle = "#2b1f22";
    figure(c, cx - size * 0.14, h + size * 0.05, size * 0.985, 0.08, true);
    figure(c, cx + size * 0.12, h + size * 0.08, size * 1.065, -0.06, false);
  });
  stamp(ctx, bodies, Math.min(w, h) * 0.0015);
  glow(ctx, sunX, sunY, w * 0.16, "#ffe1aa", 0.5, "screen");
  for (let index = 1; index <= 3; index++) {
    const t = index * 0.35;
    const gx = sunX + (w / 2 - sunX) * t * 2;
    const gy = sunY + (h / 2 - sunY) * t * 2;
    oval(ctx, gx, gy, w * 0.02 * index, w * 0.02 * index, `rgba(255,210,160,${0.06 / index})`);
  }
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.fillStyle = "rgba(255,190,130,0.12)";
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

function dinner(ctx: Ctx, w: number, h: number, rng: Rng) {
  const vanishX = w * between(rng, 0.45, 0.55);
  const vanishY = h * between(rng, 0.42, 0.5);
  const back = layer(w, h, (c) => {
    c.fillStyle = vertical(c, 0, vanishY * 1.2, ["#1d2440", "#46406a", "#b5767a", "#e9a77a"]);
    c.fillRect(0, 0, w, h);
    fillBelow(c, ridge(rng, w, vanishY - h * 0.1, h * 0.12), h, vertical(c, vanishY - h * 0.1, h, ["#1c211e", "#2c2a25", "#3b3128"]));
    for (let index = 0; index < 12; index++) {
      const tx = rng() * w;
      c.fillStyle = "#171c19";
      c.beginPath();
      c.ellipse(tx, vanishY - h * between(rng, 0.12, 0.3), w * 0.025, h * between(rng, 0.12, 0.22), 0, 0, Math.PI * 2);
      c.fill();
    }
  });
  stamp(ctx, back, Math.min(w, h) * 0.008);
  for (let strand = 0; strand < 4; strand++) {
    const y0 = h * between(rng, 0.02, 0.3);
    const y1 = h * between(rng, 0.02, 0.3);
    const sag = h * between(rng, 0.05, 0.14);
    for (let index = 0; index <= 18; index++) {
      const t = index / 18;
      const x = t * w;
      const y = y0 + (y1 - y0) * t + Math.sin(t * Math.PI) * sag;
      const r = Math.min(w, h) * between(rng, 0.018, 0.035);
      const disc = ctx.createRadialGradient(x, y, 0, x, y, r);
      disc.addColorStop(0, "rgba(255,214,150,0.55)");
      disc.addColorStop(0.8, "rgba(255,190,110,0.45)");
      disc.addColorStop(1, "rgba(255,190,110,0)");
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      oval(ctx, x, y, r, r, disc);
      ctx.restore();
    }
  }
  const tableTop = vanishY + h * 0.02;
  const halfFar = w * 0.03;
  const halfNear = w * 0.42;
  const table = layer(w, h, (c) => {
    c.beginPath();
    c.moveTo(vanishX - halfFar, tableTop);
    c.lineTo(vanishX + halfFar, tableTop);
    c.lineTo(vanishX + halfNear, h);
    c.lineTo(vanishX - halfNear, h);
    c.closePath();
    c.fillStyle = vertical(c, tableTop, h, ["#d8c7b6", "#efe6dc", "#f6efe6"]);
    c.fill();
    for (let index = 0; index < 160; index++) {
      const t = rng() ** 1.4;
      const y = tableTop + t * (h - tableTop);
      const half = halfFar + (halfNear - halfFar) * t;
      const x = vanishX + (rng() - 0.5) * half * 0.35;
      oval(c, x, y, w * 0.007 * (0.3 + t), h * 0.005 * (0.3 + t), choose(rng, ["#33492c", "#263a22", "#4a6338"]), rng() * Math.PI);
      if (rng() < 0.5) oval(c, x + (rng() - 0.5) * w * 0.01, y, w * 0.005 * (0.3 + t), w * 0.005 * (0.3 + t), choose(rng, ["#f6f0e6", "#efd9d2", "#f3e7c9"]));
    }
    for (let row = 1; row < 9; row++) {
      const t = (row / 9) ** 1.5;
      const y = tableTop + t * (h - tableTop);
      const half = halfFar + (halfNear - halfFar) * t;
      for (const side of [-1, 1]) {
        const px = vanishX + side * half * 0.7;
        oval(c, px, y, w * 0.03 * (0.2 + t), h * 0.012 * (0.2 + t), "#fbf8f2");
        oval(c, px, y, w * 0.02 * (0.2 + t), h * 0.008 * (0.2 + t), "#ece4d8");
        c.fillStyle = "rgba(255,255,255,0.6)";
        c.fillRect(px + side * w * 0.025 * (0.2 + t), y - h * 0.04 * (0.2 + t), Math.max(1, w * 0.004 * (0.2 + t)), h * 0.035 * (0.2 + t));
      }
    }
  });
  const sharp = layer(w, h, (c) => place(c, table));
  const soft = layer(w, h, (c) => {
    c.filter = `blur(${Math.min(w, h) * 0.006 * density}px)`;
    place(c, table);
  });
  const mask = layer(w, h, (c) => {
    place(c, soft);
    c.globalCompositeOperation = "destination-in";
    c.fillStyle = vertical(c, tableTop, h, ["rgba(0,0,0,1)", "rgba(0,0,0,0.2)", "rgba(0,0,0,0)"]);
    c.fillRect(0, 0, w, h);
  });
  stamp(ctx, sharp, 0);
  stamp(ctx, mask, 0);
  for (let index = 0; index < 14; index++) {
    const t = (index / 14) ** 1.4;
    const y = tableTop + t * (h - tableTop) - h * 0.02;
    const half = halfFar + (halfNear - halfFar) * t;
    const x = vanishX + (rng() - 0.5) * half * 0.3;
    glow(ctx, x, y, w * 0.05 * (0.3 + t), "#ffb867", 0.55);
    oval(ctx, x, y, w * 0.002 * (0.4 + t), h * 0.006 * (0.4 + t), "#fff2cc");
  }
  for (let index = 0; index < 10; index++) {
    const t = (index / 10) ** 1.3;
    const y = tableTop + t * (h - tableTop);
    const half = halfFar + (halfNear - halfFar) * t;
    for (const side of [-1, 1]) {
      ctx.fillStyle = "rgba(30,24,26,0.85)";
      const cw = w * 0.035 * (0.2 + t);
      ctx.fillRect(vanishX + side * (half + cw * 0.3) - cw / 2, y - h * 0.08 * (0.2 + t), cw, h * 0.09 * (0.2 + t));
    }
  }
}

const SCENES: Record<string, (ctx: Ctx, w: number, h: number, rng: Rng) => void> = {
  village,
  beach,
  boat,
  terrace,
  lemons,
  couple,
  dinner,
};

const SCENE_KINDS = Object.keys(SCENES);

function develop(ctx: Ctx, w: number, h: number, rng: Rng) {
  const vignette = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.38, w / 2, h / 2, Math.hypot(w, h) * 0.62);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.26)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);
  const curve = new Uint8ClampedArray(256 * 3);
  for (let value = 0; value < 256; value++) {
    const x = value / 255;
    const s = x < 0.5 ? 0.5 * (2 * x) ** 1.18 : 1 - 0.5 * (2 - 2 * x) ** 1.18;
    const toned = 0.035 + s * 0.94;
    curve[value] = Math.round(Math.min(1, toned * 1.015 + 0.006) * 255);
    curve[256 + value] = Math.round(toned * 255);
    curve[512 + value] = Math.round(Math.min(1, toned * 0.97 + 0.018 * (1 - x)) * 255);
  }
  const image = ctx.getImageData(0, 0, w, h);
  const data = image.data;
  for (let index = 0; index < data.length; index += 4) {
    const grain = (rng() + rng() - 1) * 9;
    data[index] = curve[data[index]!]! + grain;
    data[index + 1] = curve[256 + data[index + 1]!]! + grain;
    data[index + 2] = curve[512 + data[index + 2]!]! + grain;
  }
  ctx.putImageData(image, 0, 0);
}

function drawScene(recipe: string, width: number, height: number, longEdge = Math.max(width, height)): HTMLCanvasElement {
  const [kind = "village", seedText = "1"] = recipe.split(":");
  const seed = hash(kind) ^ Math.imul(Number(seedText) || 1, 2654435761);
  const rng = random(seed);
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const scale = Math.min(1, longEdge / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  density = scale;
  ctx.scale(canvas.width / w, canvas.height / h);
  try {
    (SCENES[kind] ?? village)(ctx, w, h, rng);
  } finally {
    density = 1;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  develop(ctx, canvas.width, canvas.height, rng);
  return canvas;
}

const sceneUrls = new Map<string, Promise<string>>();

export function sceneUrl(recipe: string, width: number, height: number, longEdge: number): Promise<string> {
  const key = `${recipe}@${width}x${height}@${Math.min(longEdge, Math.max(width, height))}`;
  let url = sceneUrls.get(key);
  if (!url) {
    url = new Promise<string>((resolve, reject) =>
      drawScene(recipe, width, height, longEdge).toBlob(
        (blob) => (blob ? resolve(URL.createObjectURL(blob)) : reject(new Error("Could not draw this preview."))),
        "image/jpeg",
        0.9,
      ),
    );
    sceneUrls.set(key, url);
    url.catch(() => {
      if (sceneUrls.get(key) === url) sceneUrls.delete(key);
    });
  }
  return url;
}

export async function samplePhoto(index: number): Promise<File> {
  const kind = SCENE_KINDS[index % SCENE_KINDS.length]!;
  const portrait = index % 3 === 1;
  const canvas = drawScene(`${kind}:${100 + index}`, portrait ? 1600 : 2400, portrait ? 2400 : 1600);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("Could not draw the sample photo."))), "image/jpeg", 0.92),
  );
  const name = `SAMPLE_${String(index + 1).padStart(4, "0")}.jpg`;
  return new File([blob], name, { type: "image/jpeg" });
}
