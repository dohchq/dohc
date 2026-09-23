import * as T from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createSectionMaterial } from './figure-studio';

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
  const cast = metal(0x7b848c, .52, .82);
  const brass = metal(0x9b8052, .32);
  const section = createSectionMaterial(1.6);
  materials.push(section);
  textures.push(section.map!);

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
  const dispose = () => {
    const geometries = new Set<T.BufferGeometry>();
    root.traverse(object => { if (object instanceof T.Mesh) geometries.add(object.geometry); });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
    textures.forEach(texture => texture.dispose());
  };
  return { root, silver, bright, steel, dark, cast, brass, section, mesh, box, cylinder, ring, bolt, dispose };
}

interface GearSpec { teeth: number; inner: number; outer: number; height: number; cone: number; twist?: number; bore?: number; thickness?: number }

/** Tapered teeth between two radii, chamfered, lifted onto the pitch cone
 * and swept slightly so the gear reads as a spiral bevel. The axis is +y. */
function bevelTeeth({ teeth, inner, outer, height, cone, twist = 0 }: GearSpec) {
  const pitch = Math.PI * 2 / teeth;
  const half = pitch * .24;
  const at = (radius: number, angle: number) => new T.Vector2(Math.cos(angle) * radius, Math.sin(angle) * radius);
  const shapes = Array.from({ length: teeth }, (_, i) => {
    const a = i * pitch;
    return new T.Shape([at(inner, a - half), at(outer, a - half + twist), at(outer, a + half + twist), at(inner, a + half)]);
  });
  const chamfer = Math.min(height * .22, half * inner * .45);
  const geometry = new T.ExtrudeGeometry(shapes, { depth: height, bevelEnabled: true, bevelThickness: chamfer, bevelSize: chamfer, bevelOffset: -chamfer, bevelSegments: 1 });
  const position = geometry.getAttribute('position');
  const slope = Math.tan(cone);
  for (let i = 0; i < position.count; i++) {
    const radius = Math.hypot(position.getX(i), position.getY(i));
    position.setZ(i, position.getZ(i) + (outer - radius) * slope);
  }
  geometry.rotateX(-Math.PI / 2);
  geometry.computeVertexNormals();
  return geometry;
}

export function createDifferential(): DriveModel {
  const w = workshop();
  const { root, silver, bright, steel, dark, cast, brass, section, mesh, box, cylinder, ring, bolt } = w;
  const axisX = new T.Group(); axisX.rotation.z = -Math.PI / 2; root.add(axisX);

  // Cast housing turned around the axle, with the quarter facing the viewer cut away.
  const profile = new T.SplineCurve([[.5, -1.28], [.64, -1.08], [1.18, -.84], [1.5, -.52], [1.58, -.18], [1.5, .14], [1.18, .46], [.74, .78], [.62, 1.06], [.5, 1.28]]
    .map(([r, h]) => new T.Vector2(r, h))).getPoints(48);
  const wall = .13;
  const inside = profile.map((point, i) => {
    const before = profile[Math.max(0, i - 1)], after = profile[Math.min(profile.length - 1, i + 1)];
    const normal = new T.Vector2(after.y - before.y, before.x - after.x).normalize();
    return point.clone().addScaledVector(normal, -wall);
  });
  const housing = new T.Group(); axisX.add(housing);
  const sweep = Math.PI * 1.5;
  // Each run is one smooth stretch of a counter-clockwise profile; runs meet at hard edges.
  const turned = (runs: T.Vector2[][]) => {
    for (const run of runs) mesh(new T.LatheGeometry(run, 120, 0, sweep), cast, housing);
    const outline = new T.Shape(runs.flatMap(run => run.slice(0, -1)));
    for (const angle of [0, sweep]) {
      const face = mesh(new T.ShapeGeometry(outline, 24), section, housing);
      face.rotation.y = angle === 0 ? -Math.PI / 2 : Math.PI;
      face.castShadow = false;
    }
  };
  const last = profile.length - 1;
  turned([profile, [profile[last], inside[last]], [...inside].reverse(), [inside[0], profile[0]]]);
  // The two housing halves bolt together at a flange just behind the crown wheel.
  const flange = [[1.44, .08], [1.66, .08], [1.66, .2], [1.44, .2]].map(([r, h]) => new T.Vector2(r, h));
  turned(flange.map((point, i) => [point, flange[(i + 1) % flange.length]]));
  for (let i = 1; i < 12; i++) {
    const a = i * sweep / 12;
    bolt([Math.sin(a) * 1.56, .23, Math.cos(a) * 1.56], .045, housing);
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

  const gear = (parent: T.Object3D, position: number[], spec: GearSpec, body = silver) => {
    const group = new T.Group(); group.position.set(position[0], position[1], position[2]); parent.add(group);
    const { inner, outer, cone, bore = inner * .45, thickness = .12 } = spec;
    const rise = (outer - inner) * Math.tan(cone);
    mesh(new T.LatheGeometry([[bore, -thickness], [outer, -thickness], [outer, 0], [inner, rise], [bore, rise], [bore, -thickness]]
      .map(([r, h]) => new T.Vector2(r, h)), 72), body, group);
    mesh(bevelTeeth(spec), bright, group);
    return group;
  };

  const carrier = new T.Group(); axisX.add(carrier);
  // A 41:11 crown and pinion: a 3.73 final drive.
  gear(carrier, [0, -.34, 0], { teeth: 41, inner: .86, outer: 1.2, height: .1, cone: .12, twist: .1, bore: .47, thickness: .1 });
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
  const sideGear = { teeth: 16, inner: .17, outer: .36, height: .07, cone: Math.PI / 4, thickness: .08 };
  gear(carrier, [0, -.26, 0], sideGear);
  gear(carrier, [0, .26, 0], sideGear).rotation.z = Math.PI;
  const cross = cylinder(.06, 1.0, [0, 0, 0], bright, carrier); cross.rotation.z = Math.PI / 2;
  const spiderGear = { teeth: 10, inner: .1, outer: .22, height: .06, cone: Math.PI / 4, thickness: .07 };
  gear(carrier, [.3, 0, 0], spiderGear, brass).rotation.z = Math.PI / 2;
  gear(carrier, [-.3, 0, 0], spiderGear, brass).rotation.z = -Math.PI / 2;

  // Pinion and short prop shaft with a visible universal joint.
  const input = new T.Group(); input.rotation.x = Math.PI / 2; input.position.set(-.1, -.12, 0); root.add(input);
  cylinder(.36, .5, [0, 1.55, 0], cast, input);
  ring(.35, .04, [0, 1.8, 0], silver, input);
  const shaft = new T.Group(); input.add(shaft);
  gear(shaft, [0, .92, 0], { teeth: 11, inner: .12, outer: .3, height: .08, cone: .6, twist: -.1, thickness: .1 }).rotation.z = Math.PI;
  cylinder(.16, 1.15, [0, 1.72, 0], bright, shaft);
  cylinder(.28, .12, [0, 1.9, 0], steel, shaft);
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
  batchAssemblies([root, carrier, shaft]);
  return { root, update: time => { carrier.rotation.y = time * .2; shaft.rotation.y = -time * .2 * 41 / 11; }, dispose: w.dispose };
}
