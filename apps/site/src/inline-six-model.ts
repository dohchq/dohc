import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** Jaguar XK-inspired DOHC inline-six study, with illustrative dimensions. */
export function createInlineSixEngine() {
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
    color: 0x3c4246,
    metalness: 0.78,
    roughness: 0.48,
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
  box([1.78, 0.45, 5.5], [0, 0.68, 0], metal, engine, 0.08);
  for (const side of [-1, 1]) {
    for (let row = 0; row < 3; row++)
      box([0.025, 0.023, 5.08], [side * 0.895, 0.57 + row * 0.105, 0], steel, engine, 0.007);
    for (const z of stations) {
      box([0.14, 0.36, 0.53], [side * 0.9, 0.68, z], metal);
      fastener([side * 0.77, 0.94, z + 0.31], engine, 'y', 0.045);
    }
  }

  // Open cam troughs, direct-acting tappets, bearing caps and six lobes per shaft.
  for (const side of [-1, 1]) {
    const x = side * 0.51;
    box([0.63, 0.065, 5.25], [x, 0.94, 0], graphite);
    for (const edge of [-1, 1]) {
      box([0.055, 0.22, 5.28], [x + edge * 0.315, 1.045, 0], metal, engine, 0.018);
      box([0.07, 0.025, 5.32], [x + edge * 0.315, 1.16, 0], chrome, engine, 0.009);
    }
    for (const z of [-2.65, 2.65]) box([0.67, 0.22, 0.055], [x, 1.045, z], metal);
    cylinder(0.066, 5.3, [x, 1.28, 0], steel);
    stations.forEach((z, i) => {
      cylinder(0.125, 0.1, [x, 1.035, z], chrome, engine, 'y', 24);
      const lobeShape = new THREE.Shape();
      lobeShape.moveTo(-0.105, 0);
      lobeShape.bezierCurveTo(-0.115, -0.145, 0.115, -0.145, 0.105, 0);
      lobeShape.bezierCurveTo(0.1, 0.09, 0.052, 0.2, 0, 0.2);
      lobeShape.bezierCurveTo(-0.052, 0.2, -0.1, 0.09, -0.105, 0);
      const lobe = part(new THREE.ExtrudeGeometry(lobeShape, {
        depth: 0.13, bevelEnabled: true, bevelSize: 0.009,
        bevelThickness: 0.009, bevelSegments: 2, curveSegments: 12,
      }), chrome, engine, [x, 1.28, z - 0.065]);
      lobe.rotation.z = [0, 2.1, 4.2, 4.2, 2.1, 0][i] + side * 0.7;
    });
    for (const z of [-2.48, -0.84, 0.84, 2.48]) {
      box([0.4, 0.13, 0.17], [x, 1.35, z], metal, engine, 0.035);
      for (const dx of [-0.15, 0.15]) fastener([x + dx, 1.425, z], engine, 'y', 0.028);
    }
  }

  // Domed, hollow aluminum shells. One floats above its shaft; the other is cut away at the front.
  function camCover(x: number, y: number, length: number, z: number, cutaway = false) {
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
    part(new THREE.ExtrudeGeometry(shell, {
      depth: length, bevelEnabled: true, bevelSize: 0.012,
      bevelThickness: 0.012, bevelSegments: 3, curveSegments: 24,
    }), chrome, cover, [0, 0, -length / 2]);
    const endProfile = new THREE.Shape();
    endProfile.moveTo(-0.35, 0);
    endProfile.lineTo(-0.35, 0.12);
    endProfile.bezierCurveTo(-0.35, 0.44, 0.35, 0.44, 0.35, 0.12);
    endProfile.lineTo(0.35, 0);
    endProfile.closePath();
    // Keep the seated cover's cut face open so its wall thickness remains visible.
    for (const end of cutaway ? [-1] : [-1, 1]) {
      part(new THREE.ExtrudeGeometry(endProfile, {
        depth: 0.035, bevelEnabled: true, bevelSize: 0.012,
        bevelThickness: 0.012, bevelSegments: 3, curveSegments: 24,
      }), chrome, cover, [0, 0, end * length / 2 - 0.0175]);
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
  const liftedCover = camCover(0.51, 2.02, 5.27, 0);
  camCover(-0.51, 1.18, 3.22, -1.025, true);
  cylinder(0.17, 0.07, [0, 0.42, -1.95], chrome, liftedCover, 'y');
  box([0.23, 0.045, 0.06], [0, 0.48, -1.95], steel, liftedCover, 0.012);
  // Fine red enamel inset, shared with the small ignition details.
  box([0.23, 0.012, 0.72], [0, 0.362, 0.1], red, liftedCover, 0.025);
  const badgeCanvas = document.createElement('canvas');
  badgeCanvas.width = 512; badgeCanvas.height = 128;
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
  const badge = part(new THREE.PlaneGeometry(0.61, 0.155), badgeMaterial, liftedCover, [0, 0.371, 0.1]);
  badge.rotation.set(-Math.PI / 2, 0, Math.PI / 2);

  // Central spark plugs and six leads follow the valley between the cam housings.
  for (const [i, z] of stations.entries()) {
    cylinder(0.095, 0.045, [0, 0.97, z], chrome, engine, 'y', 6);
    cylinder(0.058, 0.15, [0, 1.065, z], metal, engine, 'y', 20);
    for (let j = 0; j < 4; j++) ring(0.061, 0.008, [0, 1.02 + j * 0.032, z], chrome, engine, 'y');
    cylinder(0.073, 0.1, [0, 1.18, z], red, engine, 'y', 20);
    tube([[0, 1.23, z], [0.11, 1.37, z + 0.1], [0.14, 1.38, 2.45],
      [0.22 + i * 0.022, 1.1, 2.85], [0.85, 0.18, 2.32 + i * 0.035]], 0.021, rubber, engine, 40);
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
    cylinder(0.235, 0.57, [1.8, 0.7, z], metal, engine, 'x');
    box([0.44, 0.13, 0.53], [1.77, 0.86, z], metal);
    cylinder(0.22, 0.33, [1.77, 1.065, z], chrome, engine, 'y');
    const dome = part(new THREE.SphereGeometry(0.22, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), chrome, engine, [1.77, 1.23, z]);
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
    for (const dz of [-0.22, 0.22]) fastener([-1.03, 0.71, z + dz], engine, 'x', 0.035);
    const group = i < 3 ? -1 : 1;
    const endZ = group * 1.24;
    tube([[-1, 0.66, z], [-1.36, 0.66, z], [-1.65 - (i % 3) * 0.11, 0.25, z],
      [-1.71 - (i % 3) * 0.06, -0.65, z * 0.8], [-1.64, -1.2, endZ + (i % 3 - 1) * 0.16]],
      0.125, chrome, engine, 48);
    ring(0.133, 0.016, [-1.22, 0.66, z], steel, engine, 'x');
  });
  for (const z of [-1.24, 1.24]) {
    cylinder(0.235, 0.45, [-1.64, -1.37, z], steel, engine, 'y');
    ring(0.242, 0.022, [-1.64, -1.57, z], chrome, engine, 'y');
    cylinder(0.205, 0.01, [-1.64, -1.6, z], black, engine, 'y');
  }

  // Front timing chest. A small open upper section shows both cam sprockets and the chain.
  plate([[-0.74, -1.04], [0.74, -1.04], [0.73, 0.94], [0.54, 1.07],
    [-0.54, 1.07], [-0.73, 0.94]], 0.16, [0, 0, 2.69], metal);
  for (const x of [-0.66, 0.66])
    for (const y of [-0.85, -0.3, 0.3, 0.85]) fastener([x, y, 2.89], engine, 'z', 0.044);
  function sprocket(x: number, y: number, r: number) {
    cylinder(r, 0.065, [x, y, 2.72], steel);
    ring(r - 0.045, 0.016, [x, y, 2.76], chrome);
    fastener([x, y, 2.77], engine, 'z', 0.06);
    for (let i = 0; i < 24; i++) {
      const a = i * Math.PI / 12;
      const tooth = box([0.034, 0.036, 0.07], [x + Math.cos(a) * r, y + Math.sin(a) * r, 2.72], metal, engine, 0.005);
      tooth.rotation.z = a;
    }
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3;
      cylinder(r * 0.14, 0.003, [x + Math.cos(a) * r * 0.58, y + Math.sin(a) * r * 0.58, 2.757], black);
    }
  }
  sprocket(-0.51, 1.28, 0.265);
  sprocket(0.51, 1.28, 0.265);
  const chain = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.76, 1.26, 2.72), new THREE.Vector3(-0.66, 1.51, 2.72),
    new THREE.Vector3(0, 1.55, 2.72), new THREE.Vector3(0.66, 1.51, 2.72),
    new THREE.Vector3(0.76, 1.26, 2.72), new THREE.Vector3(0.22, 0.53, 2.72),
    new THREE.Vector3(0, 0.4, 2.72), new THREE.Vector3(-0.22, 0.53, 2.72),
  ], true, 'centripetal');
  for (let i = 0; i < 82; i++) {
    const p = chain.getPointAt(i / 82);
    const tangent = chain.getTangentAt(i / 82);
    const link = box([0.045, 0.071, 0.075], p.toArray(), i % 2 ? steel : chrome, engine, 0.012);
    link.rotation.z = -Math.atan2(tangent.x, tangent.y);
    cylinder(0.015, 0.09, p.toArray(), steel, engine, 'z', 12);
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
  const beltPath = new THREE.Shape();
  beltPath.moveTo(-0.44, -0.73);
  beltPath.lineTo(-0.34, 0.25);
  beltPath.quadraticCurveTo(-0.27, 0.72, 0.2, 0.52);
  beltPath.lineTo(1.28, -0.29);
  beltPath.quadraticCurveTo(1.5, -0.61, 1.16, -0.72);
  beltPath.lineTo(0.12, -1.15);
  beltPath.quadraticCurveTo(-0.4, -1.32, -0.44, -0.73);
  const beltPoints = beltPath.getPoints(110);
  for (const z of [3.035, 3.07, 3.105])
    tube(beltPoints.map(p => [p.x, p.y, z]), 0.024, rubber, engine, 150);
  tube([[0, 0.49, 2.89], [0.2, 0.78, 3.02], [0.63, 0.9, 2.95]], 0.1, metal);
  ring(0.112, 0.02, [0.63, 0.9, 2.95], steel, engine, 'x');

  // Rear flywheel housing and starter complete the silhouette from the back.
  const bellHousing = part(new THREE.CylinderGeometry(0.7, 1.04, 0.66, 64), metal, engine, [0, -0.48, -3.02]);
  bellHousing.rotation.x = Math.PI / 2;
  ring(1.015, 0.045, [0, -0.48, -2.71], steel);
  cylinder(0.72, 0.05, [0, -0.48, -3.37], steel);
  cylinder(0.3, 0.055, [0, -0.48, -3.41], graphite);
  cylinder(0.1, 0.13, [0, -0.48, -3.48], chrome);
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6;
    fastener([Math.cos(a) * 0.64, -0.48 + Math.sin(a) * 0.64, -3.41], engine, 'z', 0.037);
  }
  cylinder(0.22, 0.92, [0.94, -0.74, -2.22], graphite);
  cylinder(0.235, 0.13, [0.94, -0.74, -2.7], metal);
  cylinder(0.11, 0.52, [1.04, -0.43, -2.33], steel);
  tube([[1.04, -0.43, -2.05], [1.18, -0.2, -1.8], [1.12, 0.05, -1.33]], 0.026, rubber);
  tube([[0.8, -0.82, 0.95], [1, -0.33, 0.94], [1.04, 0.25, 0.87]], 0.026, chrome);
  ring(0.075, 0.022, [1.04, 0.33, 0.87], red);
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
