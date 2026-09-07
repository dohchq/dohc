import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** Jaguar XK-inspired DOHC inline-six study, with illustrative dimensions. */
export function createInlineSixEngine() {
  const engine = new THREE.Group();
  const textures: THREE.Texture[] = [];
  const grainCanvas = new OffscreenCanvas(256, 256);
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
    color: 0x252a28,
    metalness: 0.18,
    roughness: 0.46,
    bumpMap: grain,
    bumpScale: 0.024,
  });
  const chrome = new THREE.MeshStandardMaterial({
    color: 0xd9dfe5,
    metalness: 1,
    roughness: 0.22,
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

  const brushedCanvas = new OffscreenCanvas(256, 256);
  const brushedContext = brushedCanvas.getContext("2d")!;
  const brushedPixels = brushedContext.createImageData(256, 256);
  for (let y = 0; y < 256; y++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const line = 197 + (seed >>> 29);
    for (let x = 0; x < 256; x++) {
      const value = line + Math.round(2 * Math.sin(x * 0.07 + y * 0.13));
      brushedPixels.data.set([value, value, value, 255], (y * 256 + x) * 4);
    }
  }
  brushedContext.putImageData(brushedPixels, 0, 0);
  const brushed = new THREE.CanvasTexture(brushedCanvas);
  brushed.wrapS = brushed.wrapT = THREE.RepeatWrapping;
  brushed.repeat.set(1, 3);
  textures.push(brushed);
  const polishedAlloy = new THREE.MeshStandardMaterial({
    color: 0xcbd0d2, metalness: 0.96, roughness: 0.28,
    roughnessMap: brushed, bumpMap: brushed, bumpScale: 0.0015,
  });
  const castAlloy = new THREE.MeshStandardMaterial({
    color: 0xa9aaa5, metalness: 0.86, roughness: 0.46,
    bumpMap: grain, bumpScale: 0.018,
  });
  const porcelain = new THREE.MeshStandardMaterial({
    color: 0xded7c8, metalness: 0, roughness: 0.24,
  });
  const exhaustSteel = new THREE.MeshStandardMaterial({
    color: 0xffffff, metalness: 0.92, roughness: 0.32, vertexColors: true,
    roughnessMap: brushed,
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
      new RoundedBoxGeometry(size[0], size[1], size[2], 2, radius),
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
    segments = 32,
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
    segments = 32,
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
    direction = 1,
  ) {
    cylinder(radius * 1.4, 0.025, position, steel, parent, axis, 24);
    const face = [...position];
    face[{ x: 0, y: 1, z: 2 }[axis]] += direction * 0.025;
    cylinder(radius, 0.045, face, chrome, parent, axis, 6);
    const inset = [...face];
    inset[{ x: 0, y: 1, z: 2 }[axis]] += direction * 0.025;
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

  // The XK has one cylinder head, two longitudinal camshafts, and six central plugs.
  const stations = [-2.1, -1.26, -0.42, 0.42, 1.26, 2.1];
  box([1.48, 1.48, 5.35], [0, -0.35, 0], cast, engine, 0.14);
  box([1.63, 0.11, 5.48], [0, -1.09, 0], metal);
  box([1.58, 0.045, 5.42], [0, -1.17, 0], seal);
  box([1.44, 0.5, 5.2], [0, -1.44, 0], cast, engine, 0.12);
  box([1.45, 0.44, 2.3], [0, -1.72, -1.34], cast, engine, 0.13);
  for (const side of [-1, 1]) {
    for (const z of stations) {
      box([0.065, 1.05, 0.095], [side * 0.745, -0.32, z + 0.3], cast);
      cylinder(0.175, 0.045, [side * 0.77, -0.15, z], steel, engine, 'x');
      ring(0.146, 0.014, [side * 0.8, -0.15, z], metal, engine, 'x');
      fastener([side * 0.74, -1.015, z], engine, 'y', 0.043);
      box([0.05, 0.27, 0.075], [side * 0.727, -1.48, z], metal);
    }
  }
  fastener([0, -1.7, -2.52], engine, 'z', 0.095);
  box([1.63, 0.06, 5.45], [0, 0.43, 0], seal);
  box([1.78, 0.45, 5.5], [0, 0.68, 0], castAlloy, engine, 0.08);
  for (const side of [-1, 1]) {
    for (let row = 0; row < 3; row++)
      box([0.025, 0.023, 5.08], [side * 0.895, 0.57 + row * 0.105, 0], steel, engine, 0.007);
    for (const z of stations) {
      box([0.14, 0.36, 0.53], [side * 0.9, 0.68, z], castAlloy);
      fastener([side * 0.77, 0.94, z + 0.31], engine, 'y', 0.045);
    }
  }

  for (const side of [-1, 1]) {
    box([0.73, 0.15, 5.4], [side * 0.51, 0.945, 0], castAlloy, engine, 0.045);
    box([0.75, 0.024, 5.44], [side * 0.51, 1.025, 0], seal, engine, 0.015);
  }
  // Sealed cam housings sit on machined gasket rails above the DOHC head.
  function camCover(x: number, y: number, length: number, z: number) {
    const shell = new THREE.Shape();
    shell.moveTo(-0.35, 0);
    shell.lineTo(-0.35, 0.12);
    shell.bezierCurveTo(-0.35, 0.44, 0.35, 0.44, 0.35, 0.12);
    shell.lineTo(0.35, 0);
    shell.lineTo(0.305, 0);
    shell.lineTo(0.305, 0.12);
    shell.bezierCurveTo(0.305, 0.375, -0.305, 0.375, -0.305, 0.12);
    shell.lineTo(-0.305, 0);
    shell.closePath();
    const cover = new THREE.Group();
    cover.position.set(x, y, z);
    engine.add(cover);
    const shellGeometry = new THREE.ExtrudeGeometry(shell, {
      depth: length, bevelEnabled: true, bevelSize: 0.012,
      bevelThickness: 0.012, bevelSegments: 3, curveSegments: 32,
    });
    // Smooth the domed walls while keeping the machined rim and end bevels crisp.
    const shellPositions = shellGeometry.getAttribute("position");
    const shellNormals = shellGeometry.getAttribute("normal");
    const wallNormal = new THREE.Vector3();
    for (let i = 0; i < shellPositions.count; i++) {
      const x = shellPositions.getX(i), y = shellPositions.getY(i);
      if (y <= 0.12 || Math.abs(shellNormals.getZ(i)) > 0.01) continue;
      wallNormal.set(x / (0.35 * 0.35), (y - 0.12) / (0.24 * 0.24), 0).normalize();
      const facing = Math.sign(wallNormal.x * shellNormals.getX(i) + wallNormal.y * shellNormals.getY(i));
      shellNormals.setXYZ(i, wallNormal.x * facing, wallNormal.y * facing, 0);
    }
    part(shellGeometry, polishedAlloy, cover, [0, 0, -length / 2]);
    const endProfile = new THREE.Shape();
    endProfile.moveTo(-0.35, 0);
    endProfile.lineTo(-0.35, 0.12);
    endProfile.bezierCurveTo(-0.35, 0.44, 0.35, 0.44, 0.35, 0.12);
    endProfile.lineTo(0.35, 0);
    endProfile.closePath();
    for (const end of [-1, 1]) {
      part(new THREE.ExtrudeGeometry(endProfile, {
        depth: 0.035, bevelEnabled: true, bevelSize: 0.012,
        bevelThickness: 0.012, bevelSegments: 3, curveSegments: 24,
      }), polishedAlloy, cover, [0, 0, end * length / 2 - 0.0175]);
    }
    for (const side of [-1, 1]) {
      box([0.075, 0.035, length + 0.07], [side * 0.34, 0, 0], metal, cover, 0.012);
      box([0.055, 0.018, length], [side * 0.34, -0.026, 0], seal, cover, 0.005);
      for (let zBolt = -length / 2 + 0.16; zBolt < length / 2; zBolt += 0.84)
        fastener([side * 0.34, 0.036, zBolt], cover, 'y', 0.028);
    }
    for (const dx of [-0.125, 0.125])
      box([0.018, 0.018, length - 0.12], [dx, 0.343, 0], metal, cover, 0.006);
    return cover;
  }
  const intakeCover = camCover(0.51, 1.02, 5.38, 0);
  camCover(-0.51, 1.02, 5.38, 0);
  cylinder(0.17, 0.07, [0, 0.42, -1.95], chrome, intakeCover, 'y');
  box([0.23, 0.045, 0.06], [0, 0.48, -1.95], steel, intakeCover, 0.012);
  // Fine red enamel inset, shared with the small ignition details.
  box([0.23, 0.012, 0.72], [0, 0.362, 0.1], red, intakeCover, 0.025);
  const badgeCanvas = new OffscreenCanvas(512, 128);
  const badgeContext = badgeCanvas.getContext('2d')!;
  badgeContext.fillStyle = '#f2eee7';
  badgeContext.font = '500 84px Arial';
  badgeContext.textAlign = 'center';
  badgeContext.fillText('dohc', 256, 94);
  const badgeTexture = new THREE.CanvasTexture(badgeCanvas);
  badgeTexture.colorSpace = THREE.SRGBColorSpace;
  textures.push(badgeTexture);
  const badgeMaterial = new THREE.MeshStandardMaterial({
    map: badgeTexture, transparent: true, depthWrite: false, metalness: 0.45, roughness: 0.3,
  });
  const badge = part(new THREE.PlaneGeometry(0.61, 0.155), badgeMaterial, intakeCover, [0, 0.371, 0.1]);
  badge.rotation.set(-Math.PI / 2, 0, Math.PI / 2);

  // Central spark plugs and six leads follow the valley between the cam housings.
  for (const [i, z] of stations.entries()) {
    cylinder(0.095, 0.045, [0, 0.97, z], chrome, engine, 'y', 6);
    cylinder(0.058, 0.15, [0, 1.065, z], porcelain, engine, 'y', 20);
    for (let j = 0; j < 4; j++) ring(0.061, 0.008, [0, 1.02 + j * 0.032, z], porcelain, engine, 'y');
    cylinder(0.073, 0.1, [0, 1.18, z], red, engine, 'y', 20);
    tube([[0, 1.23, z], [-0.095 + i * 0.035, 1.37, z + 0.1], [-0.095 + i * 0.035, 1.38 + i * 0.012, 2.45],
      [0.22 + i * 0.022, 1.1, 2.85], [0.98 + Math.cos(i * Math.PI / 3) * 0.17, 0.47, 2.4 + Math.sin(i * Math.PI / 3) * 0.17]], 0.021, rubber, engine, 40);
  }
  cylinder(0.23, 0.3, [0.98, 0.11, 2.4], graphite, engine, 'y');
  cylinder(0.24, 0.08, [0.98, 0.29, 2.4], black, engine, 'y');

  // Three SU-inspired carburetors with alloy dashpots, brass fittings and open intake bells.
  for (const z of [-1.68, 0, 1.68]) {
    for (const dz of [-0.42, 0.42]) {
      tube([[0.89, 0.68, z + dz], [1.22, 0.7, z + dz], [1.52, 0.7, z + dz * 0.5],
        [1.66, 0.7, z]], 0.14, metal, engine, 30);
      ring(0.155, 0.02, [1.05, 0.68, z + dz], chrome, engine, 'x');
    }
    cylinder(0.235, 0.57, [1.8, 0.7, z], castAlloy, engine, 'x');
    box([0.44, 0.13, 0.53], [1.77, 0.86, z], metal);
    cylinder(0.22, 0.33, [1.77, 1.065, z], polishedAlloy, engine, 'y');
    const dome = part(new THREE.SphereGeometry(0.22, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), polishedAlloy, engine, [1.77, 1.23, z]);
    dome.scale.y = 0.6;
    cylinder(0.065, 0.12, [1.77, 1.4, z], black, engine, 'y', 24);
    ring(0.224, 0.019, [1.77, 0.94, z], steel, engine, 'y');
    cylinder(0.15, 0.36, [1.58, 0.43, z + 0.4], metal, engine, 'y');
    cylinder(0.17, 0.04, [1.58, 0.63, z + 0.4], chrome, engine, 'y');
    fastener([1.58, 0.67, z + 0.4], engine, 'y', 0.035);
    const profile = [[0.175, 0], [0.18, 0.16], [0.205, 0.29], [0.285, 0.38],
      [0.3, 0.39], [0.307, 0.37], [0.228, 0.27], [0.204, 0.13], [0.2, 0]];
    const bell = part(new THREE.LatheGeometry(profile.map(([r, h]) => new THREE.Vector2(r, h)), 48), chrome, engine, [2.05, 0.7, z]);
    bell.rotation.z = -Math.PI / 2;
    cylinder(0.175, 0.012, [2.075, 0.7, z], black, engine, 'x');
    cylinder(0.025, 0.32, [2.095, 0.7, z], copper, engine, 'y');
    for (const dz of [-0.2, 0.2]) fastener([2.09, 0.89, z + dz], engine, 'x', 0.03);
    cylinder(0.055, 0.12, [1.58, 0.59, z + 0.56], copper);
  }
  cylinder(0.025, 4.5, [1.44, 0.83, 0], steel);
  tube([[1.56, 0.55, -1.28], [1.4, 0.35, -1.1], [1.4, 0.35, 2.1], [1.58, 0.55, 2.08]], 0.032, copper);
  for (const z of [-1.68, 0, 1.68]) {
    tube([[1.44, 0.83, z], [1.6, 0.82, z + 0.22], [1.83, 0.68, z + 0.25]], 0.022, steel);
    tube([[1.4, 0.35, z + 0.2], [1.42, 0.47, z + 0.42], [1.58, 0.59, z + 0.48]], 0.025, copper);
  }

  // Six individual exhaust primaries join two three-cylinder collectors.
  stations.forEach((z, i) => {
    box([0.1, 0.39, 0.57], [-0.96, 0.67, z], steel);
    for (const dz of [-0.22, 0.22]) fastener([-1.03, 0.71, z + dz], engine, 'x', 0.035, -1);
    const group = i < 3 ? -1 : 1;
    const endZ = group * 1.24;
    const header = tube([[-1, 0.66, z], [-1.36, 0.66, z], [-1.65 - (i % 3) * 0.11, 0.25, z],
      [-1.71 - (i % 3) * 0.06, -0.65, z * 0.8], [-1.64, -1.2, endZ + (i % 3 - 1) * 0.16]],
      0.125, exhaustSteel, engine, 48);
    const uv = header.geometry.getAttribute("uv");
    const colors = new Float32Array(uv.count * 3);
    const hot = new THREE.Color(0x756759);
    const straw = new THREE.Color(0xb3a18a);
    const cool = new THREE.Color(0xb6bdc0);
    const color = new THREE.Color();
    for (let j = 0; j < uv.count; j++) {
      const t = uv.getX(j);
      if (t < 0.22) color.copy(hot).lerp(straw, t / 0.22);
      else color.copy(straw).lerp(cool, Math.min(1, (t - 0.22) / 0.55));
      color.toArray(colors, j * 3);
    }
    header.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    ring(0.133, 0.016, [-1.22, 0.66, z], steel, engine, 'x');
  });
  for (const z of [-1.24, 1.24]) {
    cylinder(0.235, 0.45, [-1.64, -1.37, z], steel, engine, 'y');
    ring(0.242, 0.022, [-1.64, -1.57, z], chrome, engine, 'y');
    cylinder(0.205, 0.01, [-1.64, -1.6, z], black, engine, 'y');
  }

  // A sealed timing chest connects the crankcase to both cam housings.
  plate([[-0.74, -1.04], [0.74, -1.04], [0.73, 0.94], [0.54, 1.07],
    [-0.54, 1.07], [-0.73, 0.94]], 0.16, [0, 0, 2.69], castAlloy);
  for (const x of [-0.66, 0.66])
    for (const y of [-0.85, -0.3, 0.3, 0.85]) fastener([x, y, 2.89], engine, 'z', 0.044);
  const timingOutline = new THREE.Shape();
  timingOutline.moveTo(-0.74, 0.18);
  timingOutline.lineTo(-0.86, 1.12);
  timingOutline.bezierCurveTo(-0.89, 1.5, -0.2, 1.54, -0.15, 1.22);
  timingOutline.lineTo(0.15, 1.22);
  timingOutline.bezierCurveTo(0.2, 1.54, 0.89, 1.5, 0.86, 1.12);
  timingOutline.lineTo(0.74, 0.18);
  timingOutline.closePath();
  part(new THREE.ExtrudeGeometry(timingOutline, {
    depth: 0.16, bevelEnabled: true, bevelSize: 0.035,
    bevelThickness: 0.035, bevelSegments: 3, curveSegments: 24,
  }), castAlloy, engine, [0, 0, 2.69]);
  for (const side of [-1, 1]) {
    cylinder(0.21, 0.032, [side * 0.51, 1.14, 2.895], metal);
    ring(0.185, 0.009, [side * 0.51, 1.14, 2.916], steel);
    for (const dy of [-0.12, 0.12])
      fastener([side * 0.51, 1.14 + dy, 2.924], engine, 'z', 0.03);
    for (const y of [0.56, 0.94]) fastener([side * 0.77, y, 2.895], engine, 'z', 0.035);
  }
  // Water pump, crank pulley and period generator with a single accessory belt.
  function pulley(x: number, y: number, radius: number) {
    cylinder(radius, 0.16, [x, y, 3.06], graphite);
    for (const z of [2.99, 3.13]) ring(radius, 0.022, [x, y, z], chrome);
    cylinder(radius * 0.76, 0.028, [x, y, 3.16], steel);
    fastener([x, y, 3.2], engine, 'z', 0.07);
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3;
      cylinder(radius * 0.12, 0.004, [x + Math.cos(a) * radius * 0.5, y + Math.sin(a) * radius * 0.5, 3.177], black);
    }
  }
  cylinder(0.29, 0.22, [0, 0.25, 2.93], cast);
  pulley(0, -0.73, 0.44);
  pulley(0, 0.25, 0.34);
  pulley(1.13, -0.48, 0.24);
  cylinder(0.32, 1.05, [1.13, -0.48, 2.25], graphite);
  for (const z of [1.73, 2.76]) {
    cylinder(0.335, 0.07, [1.13, -0.48, z], metal);
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      cylinder(0.047, 0.075, [1.13 + Math.cos(a) * 0.25, -0.48 + Math.sin(a) * 0.25, z + 0.015], black);
    }
  }
  box([0.72, 0.12, 0.15], [0.84, -0.83, 2.65], steel);
  // External tangents and pulley arcs form a continuous belt seated on all three pulleys.
  const pulleys = [
    { x: 0, y: -0.73, radius: 0.44 },
    { x: 1.13, y: -0.48, radius: 0.24 },
    { x: 0, y: 0.25, radius: 0.34 },
  ];
  const tangentAngles = pulleys.map((pulley, i) => {
    const next = pulleys[(i + 1) % pulleys.length];
    const dx = next.x - pulley.x, dy = next.y - pulley.y;
    const distance = Math.hypot(dx, dy);
    return Math.atan2(dy, dx) - Math.acos((pulley.radius - next.radius) / distance);
  });
  function beltOutline(thickness: number) {
    const path = new THREE.Shape();
    pulleys.forEach((pulley, i) => {
      const start = tangentAngles[(i + pulleys.length - 1) % pulleys.length];
      let end = tangentAngles[i];
      while (end < start) end += Math.PI * 2;
      path.absarc(pulley.x, pulley.y, pulley.radius + thickness, start, end, false);
    });
    path.closePath();
    return path;
  }
  const beltShape = beltOutline(0.036);
  beltShape.holes.push(beltOutline(0));
  part(new THREE.ExtrudeGeometry(beltShape, {
    depth: 0.095, bevelEnabled: true, bevelSize: 0.003,
    bevelThickness: 0.003, bevelSegments: 1, curveSegments: 20,
  }), rubber, engine, [0, 0, 3.0125]);
  tube([[0, 0.49, 2.89], [0.2, 0.78, 3.02], [0.63, 0.9, 2.95]], 0.1, metal);
  ring(0.112, 0.02, [0.63, 0.9, 2.95], steel, engine, 'x');

  // Rear flywheel housing and starter complete the silhouette from the back.
  const bellHousing = part(new THREE.CylinderGeometry(1.04, 0.7, 0.66, 64), castAlloy, engine, [0, -0.48, -3.02]);
  bellHousing.rotation.x = Math.PI / 2;
  ring(1.015, 0.045, [0, -0.48, -2.71], steel);
  cylinder(0.72, 0.05, [0, -0.48, -3.37], steel);
  cylinder(0.3, 0.055, [0, -0.48, -3.41], graphite);
  cylinder(0.1, 0.13, [0, -0.48, -3.48], chrome);
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6;
    fastener([Math.cos(a) * 0.64, -0.48 + Math.sin(a) * 0.64, -3.41], engine, 'z', 0.037, -1);
  }
  cylinder(0.22, 0.92, [0.94, -0.74, -2.22], graphite);
  cylinder(0.235, 0.13, [0.94, -0.74, -2.7], metal);
  cylinder(0.11, 0.52, [1.04, -0.43, -2.33], steel);
  tube([[1.04, -0.43, -2.05], [1.18, -0.2, -1.8], [1.12, 0.05, -1.33]], 0.026, rubber);
  tube([[0.8, -0.82, 0.95], [1, -0.33, 0.94], [1.04, 0.25, 0.87]], 0.026, chrome);
  ring(0.075, 0.022, [1.04, 0.33, 0.87], red);
  // Cast bosses and jacket covers give the block a manufactured, assembled surface.
  for (const side of [-1, 1]) {
    for (const z of [-1.68, 0, 1.68]) {
      box([0.065, 0.49, 1.1], [side * 0.768, -0.55, z], seal, engine, 0.08);
      box([0.07, 0.43, 1.03], [side * 0.815, -0.55, z], cast, engine, 0.07);
      for (const dz of [-0.4, 0.4]) {
        cylinder(0.085, 0.06, [side * 0.86, -0.55, z + dz], castAlloy, engine, 'x', 20);
        fastener([side * 0.9, -0.55, z + dz], engine, 'x', 0.036, side);
      }
      for (const dy of [-0.69, -0.41])
        box([0.03, 0.025, 0.73], [side * 0.86, dy, z], graphite, engine, 0.008);
    }
    for (const z of [-1.38, 1.4]) {
      const mount = new THREE.Group();
      mount.position.set(side * 0.82, -0.76, z);
      mount.rotation.z = -side * 0.18;
      engine.add(mount);
      box([0.58, 0.13, 0.42], [side * 0.23, 0, 0], castAlloy, mount);
      box([0.09, 0.28, 0.31], [0, 0.1, 0], cast, mount);
      cylinder(0.17, 0.12, [side * 0.45, -0.09, 0], rubber, mount, 'y');
      cylinder(0.175, 0.025, [side * 0.45, -0.16, 0], steel, mount, 'y');
      fastener([side * 0.45, 0.095, 0], mount, 'y', 0.05);
    }
  }
  for (const x of [-0.54, -0.36, -0.18, 0, 0.18, 0.36, 0.54]) {
    box([0.035, 0.065, 2.0], [x, -1.948, -1.34], metal, engine, 0.012);
    box([0.035, 0.035, 2.35], [x, -1.705, 1.34], castAlloy, engine, 0.012);
  }
  for (const z of [-2.4, -1.6, -0.8, 0, 0.8, 1.6, 2.4]) {
    for (const side of [-1, 1]) {
      cylinder(0.065, 0.055, [side * 0.79, -1.135, z], metal, engine, 'y', 20);
      fastener([side * 0.79, -1.19, z], engine, 'y', 0.032, -1);
    }
  }

  // Oil filter canister, housing, pressure sender and metal oil line.
  box([0.26, 0.22, 0.4], [0.87, -0.11, 0.5], castAlloy);
  cylinder(0.23, 0.08, [1.02, -0.2, 0.5], castAlloy, engine, 'y');
  cylinder(0.205, 0.58, [1.02, -0.53, 0.5], graphite, engine, 'y');
  ring(0.205, 0.016, [1.02, -0.79, 0.5], steel, engine, 'y');
  cylinder(0.18, 0.035, [1.02, -0.825, 0.5], metal, engine, 'y');
  fastener([1.02, -0.86, 0.5], engine, 'y', 0.045, -1);
  cylinder(0.067, 0.08, [0.98, -0.03, 0.75], copper, engine, 'y', 6);
  cylinder(0.085, 0.12, [0.98, 0.065, 0.75], graphite, engine, 'y', 24);
  tube([[0.98, 0.15, 0.75], [1.11, 0.26, 0.74], [1.08, 0.3, 1.48]], 0.017, rubber, engine, 20);
  tube([[-0.83, -0.47, -2.34], [-0.95, -0.13, -2.45], [-0.94, 0.29, -2.43],
    [-0.76, 0.81, -2.48]], 0.026, copper, engine, 30);
  for (const y of [-0.47, 0.77]) cylinder(0.058, 0.065, [-0.83, y, -2.4], copper, engine, 'y', 6);

  // Cooling rail and formed rubber hose, with slotted stainless clamps.
  function hoseClamp(position: number[], radius: number, axis: 'x' | 'y' | 'z') {
    ring(radius, 0.019, position, steel, engine, axis);
    const screw = [...position];
    screw[axis === 'y' ? 0 : 1] += radius;
    box([0.085, 0.045, 0.05], screw, metal, engine, 0.01);
    fastener(screw, engine, axis, 0.023);
  }
  cylinder(0.085, 4.54, [1.025, 0.98, -0.15], castAlloy);
  for (const z of [-1.86, -0.42, 1.65]) {
    tube([[0.9, 0.84, z], [1.025, 0.87, z], [1.025, 0.98, z]], 0.065, castAlloy, engine, 16);
    box([0.2, 0.04, 0.11], [1.025, 1.03, z], steel);
    fastener([0.93, 1.07, z], engine, 'y', 0.026);
  }
  box([0.4, 0.14, 0.38], [1.025, 0.96, 2.16], castAlloy, engine, 0.055);
  cylinder(0.18, 0.2, [1.025, 1.12, 2.16], castAlloy, engine, 'y');
  for (const dx of [-0.15, 0.15]) fastener([1.025 + dx, 1.06, 2.16], engine, 'y', 0.031);
  tube([[0.63, 0.9, 2.95], [0.83, 0.9, 2.94], [1.06, 0.92, 2.74], [1.025, 0.96, 2.28]],
    0.105, rubber, engine, 32);
  hoseClamp([0.74, 0.9, 2.95], 0.108, 'x');
  hoseClamp([1.025, 0.96, 2.37], 0.109, 'z');
  tube([[1.025, 1.22, 2.16], [1.025, 1.43, 2.18], [1.1, 1.54, 2.43], [1.1, 1.54, 2.68]],
    0.12, rubber, engine, 32);
  hoseClamp([1.025, 1.29, 2.16], 0.124, 'y');
  ring(0.108, 0.017, [1.1, 1.54, 2.69], rubber);
  cylinder(0.09, 0.008, [1.1, 1.54, 2.66], black);

  // Dashpot screws, bowl seams, jets, throttle levers and return springs.
  for (const z of [-1.68, 0, 1.68]) {
    for (let i = 0; i < 3; i++) {
      const a = i * Math.PI * 2 / 3;
      const x = 1.77 + Math.cos(a) * 0.25;
      const boltZ = z + Math.sin(a) * 0.25;
      cylinder(0.06, 0.06, [x, 0.925, boltZ], castAlloy, engine, 'y', 20);
      fastener([x, 0.96, boltZ], engine, 'y', 0.028);
    }
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI / 6;
      box([0.016, 0.065, 0.016], [1.77 + Math.cos(a) * 0.065, 1.41, z + Math.sin(a) * 0.065], graphite, engine, 0.004);
    }
    ring(0.155, 0.012, [1.58, 0.58, z + 0.4], seal, engine, 'y');
    cylinder(0.059, 0.12, [1.77, 0.43, z], copper, engine, 'y', 6);
    cylinder(0.046, 0.07, [1.77, 0.335, z], steel, engine, 'y', 20);
    tube([[1.77, 0.3, z], [1.74, 0.21, z + 0.16], [1.58, 0.28, z + 0.4]], 0.027, rubber, engine, 18);
    const lever = box([0.07, 0.27, 0.045], [1.44, 0.73, z + 0.29], steel, engine, 0.016);
    lever.rotation.z = -0.35;
    fastener([1.44, 0.83, z + 0.32], engine, 'z', 0.026);
    const spring: number[][] = [];
    for (let i = 0; i <= 96; i++) {
      const a = i * Math.PI / 6;
      spring.push([1.44 + Math.cos(a) * 0.055, 0.83 + Math.sin(a) * 0.055, z - 0.29 + i * 0.0038]);
    }
    tube(spring, 0.009, steel, engine, 100);
    for (const dz of [-0.34, 0.14]) {
      box([0.15, 0.12, 0.055], [1.44, 0.79, z + dz], castAlloy, engine, 0.018);
      fastener([1.44, 0.83, z + dz + 0.04], engine, 'z', 0.028);
    }
    const butterfly = cylinder(0.167, 0.014, [2.09, 0.7, z], copper, engine, 'x', 32);
    butterfly.rotation.y = 1.1;
    for (const dy of [-0.07, 0.07]) cylinder(0.016, 0.02, [2.11, 0.7 + dy, z], steel, engine, 'x', 12);
  }

  // Distributor towers, retaining clips, coil terminals and restrained wire routing.
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    const x = 0.98 + Math.cos(a) * 0.17;
    const z = 2.4 + Math.sin(a) * 0.17;
    cylinder(0.051, 0.11, [x, 0.36, z], graphite, engine, 'y', 20);
    cylinder(0.04, 0.09, [x, 0.43, z], rubber, engine, 'y', 20);
  }
  cylinder(0.051, 0.11, [0.98, 0.36, 2.4], graphite, engine, 'y', 20);
  cylinder(0.04, 0.11, [0.98, 0.43, 2.4], rubber, engine, 'y', 20);
  for (const dx of [-0.24, 0.24]) {
    box([0.025, 0.2, 0.065], [0.98 + dx, 0.19, 2.4], steel, engine, 0.01);
    cylinder(0.023, 0.032, [0.98 + dx, 0.115, 2.4], chrome, engine, 'x', 12);
  }
  cylinder(0.13, 0.44, [1.03, -0.17, 1.3], graphite, engine, 'y');
  ring(0.138, 0.024, [1.03, -0.15, 1.3], metal, engine, 'y');
  cylinder(0.14, 0.045, [1.03, 0.06, 1.3], black, engine, 'y');
  for (const dx of [-0.09, 0.09]) cylinder(0.024, 0.075, [1.03 + dx, 0.12, 1.3], copper, engine, 'y', 12);
  tube([[1.03, 0.13, 1.3], [1.18, 0.35, 1.53], [1.18, 0.53, 2.06], [0.98, 0.48, 2.4]], 0.027, rubber, engine, 30);
  for (const z of [-1.65, 0.03, 1.71]) {
    box([0.27, 0.037, 0.065], [0, 1.46, z], graphite, engine, 0.012);
    for (const x of [-0.12, 0.12]) cylinder(0.018, 0.56, [x, 1.18, z], metal, engine, 'y', 12);
  }

  // Machined joints, weld seams and cast ribs around the accessory and rear housings.
  for (const z of [1.88, 2.6])
    ring(0.327, 0.022, [1.13, -0.48, z], metal);
  for (const dx of [-0.21, 0.21]) {
    cylinder(0.025, 0.99, [1.13 + dx, -0.26, 2.25], steel, engine, 'z', 12);
    fastener([1.13 + dx, -0.26, 2.82], engine, 'z', 0.032);
  }
  for (let i = 0; i < 10; i++) {
    const a = i * Math.PI / 5;
    tube([[Math.cos(a) * 0.96, -0.48 + Math.sin(a) * 0.96, -2.79],
      [Math.cos(a) * 0.85, -0.48 + Math.sin(a) * 0.85, -3.04],
      [Math.cos(a) * 0.72, -0.48 + Math.sin(a) * 0.72, -3.3]], 0.028, castAlloy, engine, 12);
  }
  for (const x of [-0.48, 0.48]) {
    tube([[x, -0.88, 2.875], [x * 0.85, -0.14, 2.875], [x, 0.78, 2.875]], 0.026, castAlloy, engine, 16);
  }
  stations.forEach((z) => {
    for (const dx of [-1.12, -1.27]) ring(0.127, 0.008, [dx, 0.66, z], steel, engine, 'x');
    cylinder(0.15, 0.06, [-1.045, 0.66, z], steel, engine, 'x');
  });
  for (const z of [-1.24, 1.24]) {
    ring(0.237, 0.017, [-1.64, -1.43, z], metal, engine, 'y');
    box([0.6, 0.06, 0.46], [-1.64, -1.57, z], steel, engine, 0.1);
    for (const dx of [-0.25, 0.25]) fastener([-1.64 + dx, -1.62, z], engine, 'y', 0.034, -1);
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
