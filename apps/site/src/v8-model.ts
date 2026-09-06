import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** An original, source-built V8 exterior study. Dimensions are illustrative. */
export function createV8Engine() {
  const engine = new THREE.Group();
  const textures: THREE.Texture[] = [];
  const grainCanvas = document.createElement("canvas");
  grainCanvas.width = grainCanvas.height = 256;
  const grainContext = grainCanvas.getContext("2d")!;
  const pixels = grainContext.createImageData(256, 256);
  let seed = 6419;
  for (let i = 0; i < pixels.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const value = 100 + (seed >>> 25);
    pixels.data.set([value, value, value, 255], i);
  }
  grainContext.putImageData(pixels, 0, 0);
  const grain = new THREE.CanvasTexture(grainCanvas);
  grain.wrapS = grain.wrapT = THREE.RepeatWrapping;
  grain.repeat.set(3, 3);
  textures.push(grain);
  const metal = new THREE.MeshStandardMaterial({
    color: 0x9da3a9,
    metalness: 0.88,
    roughness: 0.34,
    bumpMap: grain,
    bumpScale: 0.013,
  });
  const cast = new THREE.MeshStandardMaterial({
    color: 0x777e86,
    metalness: 0.78,
    roughness: 0.48,
    bumpMap: grain,
    bumpScale: 0.024,
  });
  const chrome = new THREE.MeshStandardMaterial({
    color: 0xd9dfe5,
    metalness: 1,
    roughness: 0.15,
  });
  const steel = new THREE.MeshStandardMaterial({
    color: 0x646e79,
    metalness: 0.95,
    roughness: 0.28,
  });
  const black = new THREE.MeshStandardMaterial({
    color: 0x15191d,
    metalness: 0.15,
    roughness: 0.5,
    bumpMap: grain,
    bumpScale: 0.01,
  });
  const graphite = new THREE.MeshStandardMaterial({
    color: 0x343a41,
    metalness: 0.55,
    roughness: 0.35,
  });
  const rubber = new THREE.MeshStandardMaterial({
    color: 0x0b0c0e,
    roughness: 0.83,
    metalness: 0,
  });
  const copper = new THREE.MeshStandardMaterial({
    color: 0x8d542d,
    metalness: 0.85,
    roughness: 0.35,
  });
  const yellow = new THREE.MeshStandardMaterial({
    color: 0xd7b71f,
    metalness: 0.12,
    roughness: 0.37,
  });
  const red = new THREE.MeshStandardMaterial({
    color: 0x982a25,
    metalness: 0.35,
    roughness: 0.4,
  });
  const seal = new THREE.MeshStandardMaterial({
    color: 0x252a30,
    metalness: 0.35,
    roughness: 0.7,
  });

  function part(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    parent: THREE.Object3D = engine,
    position: number[] = [0, 0, 0],
  ) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(position[0], position[1], position[2]);
    parent.add(mesh);
    return mesh;
  }
  function box(
    size: number[],
    position: number[],
    material: THREE.Material,
    parent: THREE.Object3D = engine,
    radius = 0.045,
  ) {
    return part(
      new RoundedBoxGeometry(size[0], size[1], size[2], 3, radius),
      material,
      parent,
      position,
    );
  }
  function cylinder(
    radius: number,
    length: number,
    position: number[],
    material: THREE.Material,
    parent: THREE.Object3D = engine,
    axis: "x" | "y" | "z" = "z",
    segments = 48,
  ) {
    const mesh = part(
      new THREE.CylinderGeometry(radius, radius, length, segments),
      material,
      parent,
      position,
    );
    if (axis === "z") mesh.rotation.x = Math.PI / 2;
    if (axis === "x") mesh.rotation.z = Math.PI / 2;
    return mesh;
  }
  function ring(
    radius: number,
    thickness: number,
    position: number[],
    material: THREE.Material,
    parent: THREE.Object3D = engine,
    axis: "x" | "y" | "z" = "z",
  ) {
    const mesh = part(
      new THREE.TorusGeometry(radius, thickness, 8, 48),
      material,
      parent,
      position,
    );
    if (axis === "y") mesh.rotation.x = Math.PI / 2;
    if (axis === "x") mesh.rotation.y = Math.PI / 2;
    return mesh;
  }
  function tube(
    points: number[][],
    radius: number,
    material: THREE.Material,
    parent: THREE.Object3D = engine,
    segments = 48,
  ) {
    const curve = new THREE.CatmullRomCurve3(
      points.map((p) => new THREE.Vector3(...(p as [number, number, number]))),
    );
    return part(
      new THREE.TubeGeometry(curve, segments, radius, 10, false),
      material,
      parent,
    );
  }
  function fastener(
    position: number[],
    parent: THREE.Object3D = engine,
    axis: "x" | "y" | "z" = "z",
    radius = 0.055,
  ) {
    cylinder(radius * 1.4, 0.025, position, steel, parent, axis, 24);
    const face = [...position];
    face[{ x: 0, y: 1, z: 2 }[axis]] += 0.025;
    cylinder(radius, 0.045, face, chrome, parent, axis, 6);
    const inset = [...face];
    inset[{ x: 0, y: 1, z: 2 }[axis]] += 0.025;
    cylinder(radius * 0.42, 0.002, inset, black, parent, axis, 6);
  }
  function plate(
    points: number[][],
    depth: number,
    position: number[],
    material: THREE.Material,
    parent: THREE.Object3D = engine,
  ) {
    const shape = new THREE.Shape();
    shape.moveTo(points[0][0], points[0][1]);
    points.slice(1).forEach((p) => shape.lineTo(p[0], p[1]));
    shape.closePath();
    return part(
      new THREE.ExtrudeGeometry(shape, {
        depth,
        bevelEnabled: true,
        bevelSize: 0.025,
        bevelThickness: 0.025,
        bevelSegments: 2,
        steps: 1,
      }),
      material,
      parent,
      position,
    );
  }

  // Crankcase, its casting ribs, split line, and bolted sump.
  box([1.72, 1.44, 3.65], [0, -0.47, -0.05], cast, engine, 0.14);
  box([1.94, 0.13, 3.85], [0, -1.13, -0.05], metal);
  box([1.84, 0.055, 3.77], [0, -1.225, -0.05], seal);
  box([1.68, 0.7, 3.43], [0, -1.58, 0.02], cast, engine, 0.2);
  box([1.73, 0.1, 3.5], [0, -1.88, 0.02], metal);
  box([1.6, 0.33, 1.6], [0, -1.92, -0.7], cast, engine, 0.12);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 8; i++) {
      box(
        [0.1, 0.66, 0.1],
        [side * 0.845, -1.57, -1.43 + i * 0.42],
        metal,
        engine,
        0.025,
      );
      fastener([side * 0.86, -1.11, -1.63 + i * 0.46], engine, "y");
    }
    for (const z of [-1.45, -0.55, 0.35, 1.25]) {
      cylinder(0.17, 0.065, [side * 0.89, -0.55, z], steel, engine, "x");
      ring(0.145, 0.014, [side * 0.93, -0.55, z], chrome, engine, "x");
    }
  }
  cylinder(0.09, 0.1, [0.75, -1.71, 1.56], chrome, engine, "z", 6);

  // Two angled cylinder banks, heads, gasket seams, and valve covers.
  const badgeCanvas = document.createElement("canvas");
  badgeCanvas.width = 1024;
  badgeCanvas.height = 256;
  const badgeContext = badgeCanvas.getContext("2d")!;
  badgeContext.clearRect(0, 0, 1024, 256);
  badgeContext.fillStyle = "#bd3931";
  badgeContext.font = "bold 150px Arial";
  badgeContext.textAlign = "center";
  badgeContext.fillText("dohc", 512, 180);
  const badgeTexture = new THREE.CanvasTexture(badgeCanvas);
  badgeTexture.colorSpace = THREE.SRGBColorSpace;
  textures.push(badgeTexture);
  const badgeMaterial = new THREE.MeshStandardMaterial({
    map: badgeTexture,
    transparent: true,
    metalness: 0.3,
    roughness: 0.4,
    depthWrite: false,
  });
  for (const side of [-1, 1]) {
    const bank = new THREE.Group();
    bank.position.set(side * 0.6, 0.1, -0.1);
    bank.rotation.z = (-side * Math.PI) / 4;
    engine.add(bank);
    box([1.3, 0.95, 3.63], [0, 0.27, 0], cast, bank, 0.08);
    box([1.4, 0.085, 3.84], [0, 0.8, 0], seal, bank, 0.025);
    box([1.49, 0.43, 3.91], [0, 1.04, 0], metal, bank, 0.07);
    box([1.5, 0.07, 3.97], [0, 1.295, 0], chrome, bank, 0.02);
    box([1.33, 0.045, 3.76], [0, 1.35, 0], black, bank, 0.03);
    box([1.32, 0.35, 3.74], [0, 1.55, 0], graphite, bank, 0.15);
    box([1.17, 0.13, 3.45], [0, 1.735, 0], graphite, bank, 0.065);
    for (const x of [-0.59, 0.59]) {
      box([0.035, 0.035, 3.33], [x, 1.64, 0], steel, bank, 0.012);
      for (const z of [-1.57, -0.78, 0, 0.78, 1.57])
        fastener([x, 1.65, z], bank, "y");
    }
    for (const z of [-1.4, -0.47, 0.47, 1.4]) {
      // Head casting ports and ignition coils tucked under the cover edge.
      box([0.13, 0.45, 0.58], [side * 0.7, 1.0, z], cast, bank, 0.055);
      box([0.22, 0.23, 0.35], [side * 0.83, 1.2, z], black, bank, 0.045);
      box([0.1, 0.1, 0.18], [side * 0.99, 1.2, z + 0.025], seal, bank, 0.02);
      fastener([side * 0.73, 1.33, z - 0.22], bank, "y", 0.04);
      tube(
        [
          [side * 0.96, 1.17, z],
          [side * 1.12, 1.02, z + 0.04],
          [side * 1.06, 0.67, z + 0.13],
        ],
        0.045,
        rubber,
        bank,
        24,
      );
      cylinder(0.085, 0.18, [side * 0.77, 0.65, z + 0.13], chrome, bank, "x");
      for (const x of [-0.55, 0.55]) fastener([x, 0.82, z], bank, "y");
    }
    // Raised dohc badge on the original cover design.
    const badge = part(
      new THREE.PlaneGeometry(1.45, 0.36),
      badgeMaterial,
      bank,
      [0, 1.807, 0],
    );
    badge.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
    if (side === 1) {
      cylinder(0.19, 0.11, [0, 1.85, -1.23], black, bank, "y");
      cylinder(0.16, 0.055, [0, 1.93, -1.23], graphite, bank, "y");
      box([0.21, 0.05, 0.065], [0, 1.968, -1.23], yellow, bank, 0.014);
      for (let i = 0; i < 12; i++) {
        const a = (i * Math.PI) / 6;
        box(
          [0.034, 0.075, 0.035],
          [Math.cos(a) * 0.17, 1.89, -1.23 + Math.sin(a) * 0.17],
          graphite,
          bank,
          0.008,
        );
      }
    }
  }

  // Composite intake manifold: eight runners and a crowned, ribbed plenum.
  for (const side of [-1, 1])
    for (let i = 0; i < 4; i++) {
      const z = -1.25 + i * 0.8;
      tube(
        [
          [side * 1.1, 1.05, z],
          [side * 0.91, 1.52, z],
          [side * 0.5, 1.85, z],
          [side * 0.15, 1.84, z],
        ],
        0.225,
        black,
        engine,
        36,
      );
      box([0.34, 0.12, 0.55], [side * 1.05, 1.1, z], graphite, engine, 0.045);
      fastener([side * 1.17, 1.19, z + 0.18], engine, "y", 0.045);
    }
  const intakeShape = new THREE.Shape();
  intakeShape.moveTo(-0.91, 0);
  intakeShape.lineTo(0.91, 0);
  intakeShape.lineTo(0.96, 0.25);
  intakeShape.bezierCurveTo(0.9, 0.56, 0.48, 0.67, 0, 0.67);
  intakeShape.bezierCurveTo(-0.48, 0.67, -0.9, 0.56, -0.96, 0.25);
  intakeShape.closePath();
  part(
    new THREE.ExtrudeGeometry(intakeShape, {
      depth: 3.05,
      bevelEnabled: true,
      bevelSize: 0.07,
      bevelThickness: 0.07,
      bevelSegments: 4,
      steps: 1,
      curveSegments: 24,
    }),
    black,
    engine,
    [0, 1.45, -1.58],
  );
  for (let i = 0; i < 7; i++) {
    const z = -1.35 + i * 0.43;
    tube(
      [
        [-1, 1.75, z],
        [-0.86, 2.02, z],
        [-0.5, 2.2, z],
        [0, 2.26, z],
        [0.5, 2.2, z],
        [0.86, 2.02, z],
        [1, 1.75, z],
      ],
      0.043,
      graphite,
      engine,
      48,
    );
  }
  box([0.58, 0.045, 0.35], [0, 2.125, -0.94], graphite, engine, 0.025);
  for (const x of [-0.18, 0.18]) fastener([x, 2.16, -0.94], engine, "y", 0.023);
  // Fuel rails, injectors, hose ends, and a wiring harness.
  for (const side of [-1, 1]) {
    cylinder(0.075, 3.18, [side * 1.04, 1.38, -0.1], chrome);
    for (let i = 0; i < 4; i++) {
      const z = -1.3 + i * 0.82;
      cylinder(0.095, 0.23, [side * 1.04, 1.21, z], graphite, engine, "y");
      ring(0.09, 0.025, [side * 1.04, 1.29, z], red, engine, "y");
      box([0.13, 0.13, 0.18], [side * 1.14, 1.23, z], black);
      tube(
        [
          [side * 1.2, 1.25, z],
          [side * 1.29, 1.27, z + 0.15],
          [side * 1.25, 1.13, z + 0.25],
        ],
        0.027,
        rubber,
        engine,
        18,
      );
    }
    tube(
      [
        [side * 1.23, 1.17, 1.43],
        [side * 1.35, 1.14, 0.4],
        [side * 1.3, 1.12, -1.2],
        [side * 0.9, 0.85, -1.86],
      ],
      0.052,
      rubber,
    );
    cylinder(0.115, 0.13, [side * 1.04, 1.38, 1.59], steel, engine, "z", 6);
  }
  // Front throttle body: alloy flange, bored opening, butterfly and actuator.
  box([0.95, 0.91, 0.16], [0, 1.66, 1.6], metal, engine, 0.11);
  cylinder(0.37, 0.35, [0, 1.66, 1.79], metal);
  cylinder(0.304, 0.007, [0, 1.66, 1.973], black);
  ring(0.331, 0.04, [0, 1.66, 1.97], chrome);
  const butterfly = cylinder(0.287, 0.022, [0, 1.66, 1.984], copper);
  butterfly.rotation.x += 0.22;
  cylinder(0.028, 0.59, [0, 1.66, 2.005], steel, engine, "x");
  for (const x of [-0.35, 0.35])
    for (const y of [1.33, 1.99]) fastener([x, y, 1.7]);
  box([0.39, 0.5, 0.44], [0.54, 1.65, 1.77], black, engine, 0.09);
  box([0.18, 0.18, 0.14], [0.72, 1.68, 1.82], seal);

  // Four separate stainless headers per bank, with flanges and welded collectors.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const z = -1.3 + i * 0.84;
      box([0.13, 0.37, 0.64], [side * 1.75, 0.46, z], metal, engine, 0.06);
      for (const dz of [-0.24, 0.24])
        fastener([side * 1.83, 0.47, z + dz], engine, "x", 0.045);
      const endZ = -1.45 + (i % 2) * 0.19;
      tube(
        [
          [side * 1.79, 0.46, z],
          [side * (2.08 + i * 0.08), 0.38, z],
          [side * (2.25 + i * 0.085), -0.08, z - 0.05],
          [side * (2.08 + i * 0.035), -0.75, z - 0.35],
          [side * (1.85 + (i % 2) * 0.2), -1.08, endZ],
        ],
        0.145,
        chrome,
        engine,
        60,
      );
      ring(0.153, 0.017, [side * 1.97, 0.43, z], steel, engine, "x");
    }
    cylinder(0.32, 0.6, [side * 1.96, -1.09, -1.62], steel);
    ring(0.328, 0.025, [side * 1.96, -1.09, -1.88], chrome);
    cylinder(0.37, 0.07, [side * 1.96, -1.09, -1.99], metal);
    cylinder(0.274, 0.004, [side * 1.96, -1.09, -2.03], black);
    ring(0.29, 0.03, [side * 1.96, -1.09, -2.04], chrome);
    for (let i = 0; i < 3; i++) {
      const a = (i * Math.PI * 2) / 3;
      fastener([
        side * 1.96 + Math.cos(a) * 0.32,
        -1.09 + Math.sin(a) * 0.32,
        -2.04,
      ]);
    }
  }

  // Timing cover, pump castings, brackets and the accessory drive.
  plate(
    [
      [-0.88, -1.09],
      [0.88, -1.09],
      [1.05, -0.35],
      [0.8, 0.3],
      [0.67, 0.86],
      [-0.67, 0.86],
      [-0.8, 0.3],
      [-1.05, -0.35],
    ],
    0.21,
    [0, 0, 1.82],
    metal,
  );
  for (const x of [-0.82, 0.82])
    for (const y of [-0.82, -0.34, 0.18, 0.65]) fastener([x, y, 2.075]);
  cylinder(0.49, 0.29, [0, -0.73, 2.11], cast);
  cylinder(0.4, 0.25, [0, 0.34, 2.11], cast);
  tube(
    [
      [-0.4, 0.39, 2.1],
      [-0.72, 0.48, 2.11],
      [-0.8, 0.86, 2.08],
    ],
    0.16,
    metal,
  );
  tube(
    [
      [0.37, 0.4, 2.1],
      [0.71, 0.51, 2.08],
      [0.88, 0.79, 1.95],
    ],
    0.14,
    metal,
  );
  for (const side of [-1, 1]) {
    plate(
      [
        [0, 0],
        [side * 0.83, 0.18],
        [side * 0.96, -0.68],
        [side * 0.72, -1.16],
        [side * 0.36, -0.7],
      ],
      0.13,
      [side * 0.66, 0.72, 1.94],
      cast,
    );
    for (const y of [0.68, -0.06, -0.48]) fastener([side * 1.28, y, 2.12]);
  }
  function pulley(x: number, y: number, r: number, z = 2.46, spokes = 6) {
    cylinder(r, 0.2, [x, y, z], graphite);
    for (const dz of [-0.085, -0.045, 0, 0.045, 0.085])
      ring(r, 0.014, [x, y, z + dz], steel);
    cylinder(r * 0.84, 0.038, [x, y, z + 0.13], steel);
    ring(r * 0.8, 0.024, [x, y, z + 0.156], chrome);
    cylinder(r * 0.24, 0.08, [x, y, z + 0.17], metal);
    fastener([x, y, z + 0.23], engine, "z", r * 0.13);
    for (let i = 0; i < spokes; i++) {
      const a = (i * Math.PI * 2) / spokes;
      const cutout = cylinder(
        r * 0.13,
        0.006,
        [x + Math.sin(a) * r * 0.54, y + Math.cos(a) * r * 0.54, z + 0.152],
        black,
      );
      cutout.scale.y = 1.35;
    }
  }
  pulley(0, -0.9, 0.61, 2.48, 8);
  pulley(0, 0.38, 0.45, 2.42, 6);
  pulley(-1.3, 0.7, 0.37, 2.43, 5);
  pulley(-1.41, -0.71, 0.39, 2.43, 5);
  pulley(1.41, 0.8, 0.3, 2.43, 6);
  pulley(0.86, -0.25, 0.23, 2.43, 0);
  cylinder(0.51, 0.1, [0, -0.9, 2.22], black);
  // Alternator with vented front/rear cages, copper windings, and cooling fan.
  cylinder(0.48, 0.8, [1.41, 0.8, 1.8], cast);
  cylinder(0.385, 0.72, [1.41, 0.8, 1.83], copper);
  for (const z of [1.4, 2.18]) {
    cylinder(0.48, 0.1, [1.41, 0.8, z], metal);
    ring(0.41, 0.045, [1.41, 0.8, z + 0.06], chrome);
    for (let i = 0; i < 14; i++) {
      const a = (i * Math.PI * 2) / 14;
      const fin = box(
        [0.055, 0.19, 0.65],
        [1.41 + Math.cos(a) * 0.435, 0.8 + Math.sin(a) * 0.435, 1.82],
        metal,
        engine,
        0.016,
      );
      fin.rotation.z = a - Math.PI / 2;
      cylinder(
        0.07,
        0.007,
        [1.41 + Math.cos(a) * 0.33, 0.8 + Math.sin(a) * 0.33, z + 0.06],
        black,
      );
    }
  }
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI) / 6;
    const fan = box(
      [0.045, 0.25, 0.035],
      [1.41 + Math.sin(a) * 0.26, 0.8 + Math.cos(a) * 0.26, 2.3],
      steel,
      engine,
      0.012,
    );
    fan.rotation.z = -a + 0.3;
  }
  box([0.3, 0.25, 0.32], [1.62, 1.17, 1.51], black);
  cylinder(0.055, 0.1, [1.73, 1.27, 1.52], copper, engine, "y");
  tube(
    [
      [1.73, 1.32, 1.52],
      [1.9, 1.33, 1.1],
      [1.63, 0.92, 0.6],
    ],
    0.045,
    rubber,
  );
  // AC compressor and power-steering reservoir on the opposite bracket.
  cylinder(0.43, 0.9, [-1.41, -0.71, 1.69], cast);
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    box(
      [0.055, 0.055, 0.8],
      [-1.41 + Math.cos(a) * 0.44, -0.71 + Math.sin(a) * 0.44, 1.68],
      metal,
      engine,
      0.01,
    );
  }
  cylinder(0.25, 0.45, [-1.3, 0.7, 2.02], cast);
  cylinder(0.24, 0.48, [-1.3, 1.03, 1.82], black, engine, "y");
  cylinder(0.26, 0.08, [-1.3, 1.3, 1.82], graphite, engine, "y");
  tube(
    [
      [-1.56, 1.02, 1.78],
      [-1.83, 0.81, 1.6],
      [-1.86, 0.22, 1.23],
    ],
    0.065,
    rubber,
  );
  tube(
    [
      [-1.44, -0.46, 1.27],
      [-1.75, -0.36, 1.06],
      [-1.72, 0.3, 0.8],
    ],
    0.08,
    metal,
  );
  // Continuous belt follows the outside tangents of the accessory pulleys.
  const wheels = [
    { x: 1.41, y: 0.8, r: 0.315 },
    { x: -1.3, y: 0.7, r: 0.385 },
    { x: -1.41, y: -0.71, r: 0.405 },
    { x: 0, y: -0.9, r: 0.625 },
    { x: 0.86, y: -0.25, r: 0.245 },
  ];
  const tangents = wheels.map((a, i) => {
    const b = wheels[(i + 1) % wheels.length];
    return (
      Math.atan2(b.y - a.y, b.x - a.x) -
      Math.acos((a.r - b.r) / Math.hypot(b.x - a.x, b.y - a.y))
    );
  });
  const beltPoints: THREE.Vector3[] = [];
  wheels.forEach((w, i) => {
    const start = tangents[(i + wheels.length - 1) % wheels.length];
    let end = tangents[i];
    while (end < start) end += Math.PI * 2;
    for (let j = 0; j <= 16; j++) {
      const a = start + ((end - start) * j) / 16;
      beltPoints.push(
        new THREE.Vector3(
          w.x + Math.cos(a) * w.r,
          w.y + Math.sin(a) * w.r,
          2.43,
        ),
      );
    }
  });
  const beltCurve = new THREE.CurvePath<THREE.Vector3>();
  beltPoints.forEach((p, i) =>
    beltCurve.add(
      new THREE.LineCurve3(p, beltPoints[(i + 1) % beltPoints.length]),
    ),
  );
  const beltShape = new THREE.Shape();
  beltShape.moveTo(-0.018, -0.095);
  beltShape.lineTo(0.018, -0.095);
  beltShape.lineTo(0.018, 0.095);
  beltShape.lineTo(-0.018, 0.095);
  beltShape.closePath();
  part(
    new THREE.ExtrudeGeometry(beltShape, {
      steps: beltPoints.length * 2,
      bevelEnabled: false,
      extrudePath: beltCurve,
    }),
    rubber,
  );
  for (const z of [2.375, 2.485])
    part(
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(
          beltPoints.map((p) => new THREE.Vector3(p.x, p.y, z)),
          true,
          "centripetal",
        ),
        180,
        0.01,
        5,
        true,
      ),
      graphite,
    );

  // Bellhousing, flywheel inspection seam, rear sensors and starter motor.
  const housing = part(
    new THREE.CylinderGeometry(1.17, 0.87, 0.69, 64),
    cast,
    engine,
    [0, -0.34, -2.19],
  );
  housing.rotation.x = Math.PI / 2;
  ring(1.16, 0.045, [0, -0.34, -2.52], metal);
  cylinder(0.97, 0.025, [0, -0.34, -2.54], steel);
  cylinder(0.2, 0.18, [0, -0.34, -2.65], chrome);
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI) / 6;
    fastener([Math.sin(a) * 1.09, -0.34 + Math.cos(a) * 1.09, -2.55]);
    const rib = box(
      [0.06, 0.4, 0.52],
      [Math.sin(a) * 1.0, -0.34 + Math.cos(a) * 1.0, -2.16],
      metal,
      engine,
      0.02,
    );
    rib.rotation.z = -a;
  }
  cylinder(0.23, 0.77, [1, -0.8, -1.37], steel);
  cylinder(0.14, 0.51, [1.2, -0.59, -1.25], black);
  cylinder(0.09, 0.09, [1.21, -0.59, -0.95], copper);
  // Formed coolant hoses, stainless clamps, dipstick, lifting eyes and sensor wires.
  tube(
    [
      [0.81, 0.82, 1.91],
      [1.06, 1.15, 1.59],
      [1.27, 1.57, 1.01],
      [1.42, 1.66, 0.52],
    ],
    0.11,
    rubber,
  );
  ring(0.115, 0.03, [0.87, 0.89, 1.85], chrome, engine, "y");
  tube(
    [
      [-0.81, 0.85, 2.06],
      [-1.01, 1.19, 1.87],
      [-1.2, 1.48, 1.29],
      [-1.31, 1.47, 0.89],
    ],
    0.105,
    rubber,
  );
  tube(
    [
      [1.04, -0.72, 0.67],
      [1.53, -0.27, 0.57],
      [1.69, 0.39, 0.36],
      [1.85, 0.93, 0.16],
    ],
    0.027,
    chrome,
  );
  const dipstick = ring(0.115, 0.031, [1.86, 1.04, 0.16], yellow);
  dipstick.scale.y = 1.45;
  for (const side of [-1, 1]) {
    const eye = ring(0.12, 0.047, [side * 0.94, 1.46, -1.73], steel);
    eye.scale.y = 1.4;
    box([0.3, 0.14, 0.12], [side * 0.94, 1.3, -1.74], metal);
    tube(
      [
        [side * 0.9, 0.91, -1.86],
        [side * 0.79, 0.72, -2.04],
        [side * 0.35, 0.45, -2.08],
        [0, 0.05, -2.05],
      ],
      0.036,
      rubber,
    );
  }
  // Welding rings and small mounting bosses break up large uninterrupted cast faces.
  for (const side of [-1, 1])
    for (const z of [-1.25, 0, 1.25]) {
      cylinder(0.12, 0.18, [side * 0.92, -0.86, z], cast, engine, "x");
      fastener([side * 1.03, -0.86, z], engine, "x");
    }

  // The entire exterior is static. Merge by material to keep the detailed model cheap to draw.
  engine.updateMatrixWorld(true);
  const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const sourceGeometries = new Set<THREE.BufferGeometry>();
  engine.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const material = object.material as THREE.Material;
    const geometry = object.geometry.index
      ? object.geometry.toNonIndexed()
      : object.geometry.clone();
    geometry.applyMatrix4(object.matrixWorld);
    const batch = batches.get(material) ?? [];
    batch.push(geometry);
    batches.set(material, batch);
    sourceGeometries.add(object.geometry);
  });
  engine.clear();
  for (const [material, geometries] of batches) {
    const geometry = mergeGeometries(geometries)!;
    const mesh = part(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    geometries.forEach((g) => g.dispose());
  }
  sourceGeometries.forEach((g) => g.dispose());
  return {
    engine,
    dispose() {
      engine.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          (object.material as THREE.Material).dispose();
        }
      });
      textures.forEach((texture) => texture.dispose());
    },
  };
}
