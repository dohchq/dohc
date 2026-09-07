import * as T from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export interface DriveModel {
  root: T.Group;
  update: (time: number) => void;
  dispose: () => void;
}

function batchAssemblies(assemblies: T.Group[]) {
  const moving = new Set(assemblies.slice(1));
  const originals = new Set<T.BufferGeometry>();
  assemblies[0].updateMatrixWorld(true);
  for (const assembly of assemblies) {
    const inverse = assembly.matrixWorld.clone().invert();
    const batches = new Map<string, { material: T.Material; cast: boolean; receive: boolean; geometries: T.BufferGeometry[] }>();
    const meshes: T.Mesh[] = [];
    const visit = (object: T.Object3D) => {
      if (object !== assembly && moving.has(object as T.Group)) return;
      if (object instanceof T.Mesh && !Array.isArray(object.material)) meshes.push(object);
      object.children.forEach(visit);
    };
    visit(assembly);
    for (const mesh of meshes) {
      const material = mesh.material as T.Material;
      const key = `${material.uuid}:${mesh.castShadow}:${mesh.receiveShadow}`;
      const batch = batches.get(key) ?? { material, cast: mesh.castShadow, receive: mesh.receiveShadow, geometries: [] };
      const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      geometry.applyMatrix4(new T.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld));
      batch.geometries.push(geometry); batches.set(key, batch);
      originals.add(mesh.geometry); mesh.removeFromParent();
    }
    for (const batch of batches.values()) {
      const mesh = new T.Mesh(mergeGeometries(batch.geometries)!, batch.material);
      mesh.castShadow = batch.cast; mesh.receiveShadow = batch.receive;
      assembly.add(mesh);
      batch.geometries.forEach(geometry => geometry.dispose());
    }
  }
  originals.forEach(geometry => geometry.dispose());
}

function workshop() {
  const root = new T.Group();
  const textures: T.Texture[] = [];
  const materials: T.Material[] = [];
  const metal = (color: number, roughness = .3, metalness = 1) => {
    const material = new T.MeshStandardMaterial({ color, roughness, metalness });
    materials.push(material);
    return material;
  };
  const silver = metal(0xc4cbd2, .27);
  const bright = metal(0xe6ebef, .2);
  const steel = metal(0x717b84, .3);
  const dark = metal(0x242a30, .48, .75);

  const brass = metal(0x9b8052, .32);
  const mesh = (geometry: T.BufferGeometry, material: T.Material, parent: T.Object3D = root, position = [0, 0, 0]) => {
    const part = new T.Mesh(geometry, material);
    part.position.set(position[0], position[1], position[2]);
    part.castShadow = true;
    part.receiveShadow = true;
    parent.add(part);
    return part;
  };
  const box = (size: number[], pos: number[], material = silver, parent: T.Object3D = root, radius = .035) =>
    mesh(new RoundedBoxGeometry(size[0], size[1], size[2], 2, Math.min(radius, Math.min(...size) / 3)), material, parent, pos);
  const cylinder = (radius: number, height: number, pos: number[], material = silver, parent: T.Object3D = root, top = radius) =>
    mesh(new T.CylinderGeometry(top, radius, height, 64), material, parent, pos);
  const ring = (radius: number, tube: number, pos: number[], material = silver, parent: T.Object3D = root) => {
    const part = mesh(new T.TorusGeometry(radius, tube, 12, 96), material, parent, pos);
    part.rotation.x = Math.PI / 2;
    return part;
  };
  const bolt = (pos: number[], size = .045, parent: T.Object3D = root) => {
    const head = cylinder(size, size * .65, pos, bright, parent);
    const socket = mesh(new T.CylinderGeometry(size * .47, size * .47, .006, 6), dark, head, [0, size * .34, 0]);
    socket.castShadow = false;
  };
  const label = (text: string, width: number, height: number, pos: number[], parent: T.Object3D = root, light = false) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = light ? '#d2d8dd' : '#343b42';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '500 92px Arial';
    ctx.fillText(text, 512, 128);
    const texture = new T.CanvasTexture(canvas);
    texture.colorSpace = T.SRGBColorSpace;
    textures.push(texture);
    const material = new T.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    materials.push(material);
    const part = mesh(new T.PlaneGeometry(width, height), material, parent, pos);
    part.rotation.x = -Math.PI / 2;
    part.castShadow = false;
    return part;
  };
  const dispose = () => {
    const geometries = new Set<T.BufferGeometry>();
    root.traverse(object => { if (object instanceof T.Mesh) geometries.add(object.geometry); });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
    textures.forEach(texture => texture.dispose());
  };
  return { root, silver, bright, steel, dark, brass, mesh, box, cylinder, ring, bolt, label, dispose };
}

export function createDifferential(): DriveModel {
  const w = workshop();
  const { root, silver, bright, steel, dark, brass, mesh, box, cylinder, ring, bolt } = w;
  const axisX = new T.Group(); axisX.rotation.z = -Math.PI / 2; root.add(axisX);
  // A sectioned cast housing leaves the crown wheel and carrier visible.
  const housingShape = new T.Shape();
  housingShape.absarc(0, 0, 1.44, Math.PI * .04, Math.PI * 1.06, false);
  housingShape.absarc(0, 0, 1.23, Math.PI * 1.06, Math.PI * .04, true);
  housingShape.closePath();
  const casing = mesh(new T.ExtrudeGeometry(housingShape, { depth: 1.3, bevelEnabled: true, bevelThickness: .045, bevelSize: .035, bevelSegments: 3, curveSegments: 64 }), steel);
  casing.rotation.set(Math.PI, Math.PI / 2, 0); casing.position.x = -.65;
  for (const x of [-.72, .72]) {
    const rim = mesh(new T.TorusGeometry(1.36, .075, 12, 80, Math.PI * 1.02), silver);
    rim.rotation.set(Math.PI, Math.PI / 2, 0); rim.position.x = x;
    for (let i = 0; i < 6; i++) {
      const a = Math.PI * .12 + i * Math.PI * .16;
      const boss = new T.Group(); boss.position.set(x, -Math.sin(a) * 1.36, Math.cos(a) * 1.36); boss.rotation.z = Math.PI / 2; root.add(boss);
      cylinder(.12, .14, [0, 0, 0], silver, boss); bolt([0, .075, 0], .065, boss);
    }
  }
  for (let i = 0; i < 6; i++) {
    const rib = mesh(new T.TorusGeometry(1.42, .035, 8, 48, Math.PI), steel);
    rib.rotation.set(Math.PI, Math.PI / 2, 0); rib.position.x = -.5 + i * .2;
  }
  // Output shafts and bearing races share the differential axis.
  for (const sign of [-1, 1]) {
    cylinder(.19, 1.45, [0, sign * 1.45, 0], steel, axisX);
    cylinder(.43, .31, [0, sign * .97, 0], dark, axisX);
    ring(.355, .068, [0, sign * 1.12, 0], bright, axisX);
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI / 6;
      mesh(new T.SphereGeometry(.047, 10, 8), bright, axisX, [Math.cos(a) * .345, sign * 1.15, Math.sin(a) * .345]);
    }
    cylinder(.34, .16, [0, sign * 2.13, 0], silver, axisX);
    cylinder(.22, .04, [0, sign * 2.24, 0], dark, axisX);
    for (let i = 0; i < 16; i++) {
      const a = i * Math.PI / 8;
      const spline = box([.035, .3, .035], [Math.cos(a) * .195, sign * 1.89, Math.sin(a) * .195], bright, axisX, .005);
      spline.rotation.y = -a;
    }
  }
  const carrier = new T.Group(); axisX.add(carrier);
  // Lathed crown wheel with individually cut, swept bevel teeth.
  const crown = mesh(new T.LatheGeometry([new T.Vector2(.47, -.43), new T.Vector2(.95, -.43), new T.Vector2(1.17, -.32), new T.Vector2(1.17, -.17), new T.Vector2(.99, -.22), new T.Vector2(.47, -.22), new T.Vector2(.47, -.43)], 96), silver, carrier);
  const toothGeometry = new T.BoxGeometry(.15, .12, .13);
  for (let i = 0; i < 44; i++) {
    const a = i * Math.PI * 2 / 44;
    const tooth = mesh(toothGeometry, bright, crown, [Math.cos(a) * 1.1, -.135, Math.sin(a) * 1.1]);
    tooth.rotation.set(.15, -a + .2, .35);
  }
  for (const y of [-.43, .44]) {
    cylinder(.66, .10, [0, y, 0], steel, carrier);
    cylinder(.25, .14, [0, y, 0], bright, carrier);
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      bolt([Math.cos(a) * .55, y + .063, Math.sin(a) * .55], .047, carrier);
    }
  }
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4;
    const bridge = box([.15, .85, .18], [Math.cos(a) * .53, 0, Math.sin(a) * .53], steel, carrier, .06);
    bridge.rotation.y = -a;
  }
  const bevelGear = (radius: number, pos: number[], parent: T.Object3D, material = silver) => {
    const gear = new T.Group(); gear.position.set(pos[0], pos[1], pos[2]); parent.add(gear);
    cylinder(radius, .19, [0, 0, 0], material, gear, radius * .7);
    cylinder(radius * .42, .25, [0, 0, 0], dark, gear);
    for (let i = 0; i < 16; i++) {
      const a = i * Math.PI / 8;
      const tooth = box([.09, .1, .085], [Math.cos(a) * radius * .84, .08, Math.sin(a) * radius * .84], bright, gear, .008);
      tooth.rotation.y = -a;
    }
    return gear;
  };
  bevelGear(.39, [0, -.23, 0], carrier);
  const rightGear = bevelGear(.39, [0, .23, 0], carrier); rightGear.rotation.z = Math.PI;
  const cross = cylinder(.07, 1.0, [0, 0, 0], bright, carrier); cross.rotation.z = Math.PI / 2;
  const spider1 = bevelGear(.24, [.33, 0, 0], carrier, brass); spider1.rotation.z = Math.PI / 2;
  const spider2 = bevelGear(.24, [-.33, 0, 0], carrier, brass); spider2.rotation.z = -Math.PI / 2;
  // Pinion and short prop shaft with a visible universal joint.
  const input = new T.Group(); input.rotation.x = Math.PI / 2; input.position.set(-.1, -.12, 0); root.add(input);
  cylinder(.36, .48, [0, 1.3, 0], steel, input);
  ring(.35, .04, [0, 1.53, 0], silver, input);
  const shaft = new T.Group(); input.add(shaft);
  const pinion = bevelGear(.29, [0, .9, 0], shaft); pinion.rotation.z = Math.PI;
  cylinder(.16, 1.15, [0, 1.72, 0], bright, shaft);
  cylinder(.28, .12, [0, 1.8, 0], steel, shaft);
  for (const x of [-.19, .19]) box([.12, .38, .18], [x, 2.28, 0], silver, shaft);
  const universal = cylinder(.08, .54, [0, 2.4, 0], steel, shaft); universal.rotation.z = Math.PI / 2;
  const crossJoint = cylinder(.08, .45, [0, 2.4, 0], bright, shaft); crossJoint.rotation.x = Math.PI / 2;
  for (const z of [-.18, .18]) box([.17, .38, .11], [0, 2.54, z], silver, shaft);
  cylinder(.24, .75, [0, 3.0, 0], steel, shaft);
  ring(.24, .025, [0, 2.68, 0], bright, shaft);
  cylinder(.34, .10, [0, 3.42, 0], silver, shaft);
  cylinder(.19, .02, [0, 3.48, 0], dark, shaft);
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2;
    bolt([Math.cos(a) * .27, 3.49, Math.sin(a) * .27], .035, shaft);
  }
  w.label('dohc', .5, .15, [.0, -1.36, .7]);
  batchAssemblies([root, carrier, shaft]);
  return { root, update: time => { carrier.rotation.y = time * .2; shaft.rotation.y = -time * .2 * 44 / 16; }, dispose: w.dispose };
}
