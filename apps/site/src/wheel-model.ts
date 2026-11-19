import * as T from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { batchAssemblies, workshop, type DriveModel } from "./drive-models";

const turn = Math.PI * 2;
const spokes = 5;

/** A five-spoke road wheel with one lug nut missing, standing upright with
 * its face toward +z. It turns on its axle once every `period` seconds. */
export function createWheel(period = 14): DriveModel & { setEdge: (strength: number) => void } {
  const w = workshop();
  const { root, metal, silver, bright, steel, dark, cast, mesh, cylinder, ring, bolt } = w;
  const rubber = metal(0x1b1c1c, 0.81, 0);
  const sidewall = metal(0xffffff, 0.74, 0);
  const mold = document.createElement("canvas");
  mold.width = 1024;
  mold.height = 64;
  const ink = mold.getContext("2d")!;
  ink.fillStyle = "#272828";
  ink.fillRect(0, 0, mold.width, mold.height);
  ink.fillStyle = "#555655";
  ink.font = "bold 25px Arial";
  ink.textAlign = "center";
  ink.save();
  ink.translate(256, 33);
  ink.rotate(Math.PI);
  ink.fillText("dohc", 0, 8);
  ink.restore();
  ink.font = "bold 16px Arial";
  ink.fillText("225/45 R17", 768, 38);
  ink.fillStyle = "#333433";
  for (const start of [50, 562]) {
    for (let i = 0; i < 15; i++) ink.fillRect(start + i * 4, 27, 1.5, 10);
  }
  sidewall.map = new T.CanvasTexture(mold);
  sidewall.map.colorSpace = T.SRGBColorSpace;
  sidewall.map.wrapS = T.RepeatWrapping;
  sidewall.map.anisotropy = 4;
  const barrel = metal(0x555c60, 0.39, 0.85);
  barrel.side = T.DoubleSide;
  // A glow at the tire's edges, so a black tire still reads against a dark page.
  const edge = { value: 0 };
  for (const material of [rubber, sidewall])
    material.onBeforeCompile = (shader) => {
      shader.uniforms.edge = edge;
      shader.fragmentShader = `uniform float edge;\n${shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\ntotalEmissiveRadiance += edge * pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);",
      )}`;
    };
  // Local +y is the axle; the group turns it toward the viewer.
  const axle = new T.Group();
  axle.rotation.x = Math.PI / 2;
  root.add(axle);
  const wheel = new T.Group();
  axle.add(wheel);
  const lathe = (
    points: number[][],
    material: T.Material,
    parent: T.Object3D = wheel,
    segments = 88,
  ) =>
    mesh(
      new T.LatheGeometry(
        points.map(([r, y]) => new T.Vector2(r, y)),
        segments,
      ),
      material,
      parent,
    );
  const around = (count: number, place: (angle: number, i: number) => void, offset = 0) => {
    for (let i = 0; i < count; i++) place(offset + (i * turn) / count, i);
  };
  const atAngle = (part: T.Object3D, radius: number, angle: number, y: number) => {
    part.position.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
    part.rotation.y = -angle;
    return part;
  };

  const casing = new T.SplineCurve(
    [
      [0.7, -0.29],
      [0.8, -0.335],
      [0.9, -0.35],
      [0.955, -0.325],
      [0.97, -0.27],
    ].map(([r, y]) => new T.Vector2(r, y)),
  ).getPoints(16);
  lathe(
    casing.map((p) => [p.x, p.y]),
    sidewall,
  );
  lathe(
    [
      [0.97, -0.27],
      [0.97, 0.27],
    ],
    rubber,
  );
  lathe(casing.map((p) => [p.x, -p.y]).reverse(), sidewall);
  for (const [r, y] of [
    [0.78, 0.337],
    [0.943, 0.331],
  ])
    ring(r, 0.005, [0, y, 0], rubber, wheel);
  const blocks = 58;
  const pitch = turn / blocks;
  for (const [y, halfWidth, offset, slant] of [
    [-0.207, 0.067, 0, 0.053],
    [-0.073, 0.053, 0.46, 0.027],
    [0.061, 0.057, 0.1, -0.031],
    [0.201, 0.068, 0.62, -0.051],
  ]) {
    const tread = new T.Shape();
    tread.moveTo(-0.043, -halfWidth);
    tread.lineTo(0.038, -halfWidth);
    tread.lineTo(0.042 + slant * 0.55, 0.004);
    tread.lineTo(0.036 + slant, halfWidth);
    tread.lineTo(-0.047 + slant, halfWidth);
    tread.lineTo(-0.035 + slant * 0.55, 0);
    tread.closePath();
    const block = new T.ExtrudeGeometry(tread, { depth: 0.018, bevelEnabled: false });
    const vertices = block.getAttribute("position");
    for (let j = 0; j < vertices.count; j++) {
      const angle = vertices.getX(j);
      const axial = vertices.getY(j) + y;
      const radius = 0.969 + vertices.getZ(j) - Math.max(0, Math.abs(axial) - 0.205) * 0.13;
      vertices.setXYZ(j, radius * Math.sin(angle), axial, radius * Math.cos(angle));
    }
    block.computeVertexNormals();
    around(
      blocks,
      (angle) => {
        mesh(block, rubber, wheel).rotation.y = angle;
      },
      offset * pitch,
    );
  }

  // Rim: a bright front flange, the barrel seen through the spokes, a hub pad.
  lathe(
    [
      [0.735, -0.31],
      [0.68, -0.29],
      [0.665, 0.24],
      [0.705, 0.27],
      [0.74, 0.305],
      [0.725, 0.325],
      [0.69, 0.305],
      [0.64, 0.27],
    ],
    barrel,
  );
  ring(0.712, 0.022, [0, 0.305, 0], bright, wheel);
  lathe(
    [
      [0.247, 0.165],
      [0.29, 0.212],
      [0.292, 0.264],
      [0.254, 0.3],
      [0.18, 0.306],
      [0.115, 0.315],
      [0.06, 0.305],
    ],
    silver,
  );
  const outline = new T.Shape();
  outline.moveTo(0.245, -0.095);
  outline.quadraticCurveTo(0.39, -0.086, 0.46, -0.085);
  outline.quadraticCurveTo(0.56, -0.094, 0.653, -0.175);
  outline.lineTo(0.685, -0.115);
  outline.quadraticCurveTo(0.617, -0.046, 0.49, 0);
  outline.quadraticCurveTo(0.617, 0.046, 0.685, 0.115);
  outline.lineTo(0.653, 0.175);
  outline.quadraticCurveTo(0.56, 0.094, 0.46, 0.085);
  outline.quadraticCurveTo(0.39, 0.086, 0.245, 0.095);
  outline.closePath();
  const spoke = new T.ExtrudeGeometry(outline, {
    depth: 0.055,
    bevelEnabled: true,
    bevelThickness: 0.014,
    bevelSize: 0.012,
    bevelSegments: 2,
    curveSegments: 6,
  });
  const vertices = spoke.getAttribute("position");
  const normals = spoke.getAttribute("normal");
  const finish = new Float32Array(vertices.count * 3);
  const flank = new T.Color(0x423e38);
  const normal = new T.Vector3();
  const cut = new T.Color(0xb1aa98);
  const color = new T.Color();
  for (let j = 0; j < vertices.count; j++) {
    const r = vertices.getX(j);
    const across = vertices.getY(j);
    const arc = ((r - 0.245) / 0.44) * Math.PI;
    const dish = 0.041 * Math.sin(arc);
    vertices.setZ(j, vertices.getZ(j) + 0.23 - dish - 0.66 * across * across);
    normal.fromBufferAttribute(normals, j);
    color
      .copy(flank)
      .lerp(cut, Math.max(0, normal.z))
      .toArray(finish, j * 3);
    normal.x += normal.z * ((0.041 * Math.PI) / 0.44) * Math.cos(arc);
    normal.y += normal.z * 1.32 * across;
    normal.normalize();
    normals.setXYZ(j, normal.x, normal.y, normal.z);
  }
  spoke.setAttribute("color", new T.BufferAttribute(finish, 3));
  spoke.rotateX(-Math.PI / 2);

  const forged = metal(0xffffff, 0.28);
  forged.vertexColors = true;
  around(spokes, (angle) => {
    mesh(spoke, forged, wheel).rotation.y = -angle;
  });
  lathe(
    [
      [0.112, 0.3],
      [0.11, 0.31],
      [0.09, 0.33],
      [0.05, 0.342],
      [0, 0.345],
    ],
    w.brass,
    wheel,
    48,
  );

  // Lug studs between the spokes. The first has no nut: its bare thread and
  // the dark seat show where the nut was.
  around(
    spokes,
    (angle, i) => {
      const at = [Math.cos(angle) * 0.23, 0, Math.sin(angle) * 0.23];
      if (i === 0) {
        cylinder(0.02, 0.1, [at[0], 0.345, at[2]], steel, wheel);
        for (let k = 0; k < 5; k++)
          ring(0.02, 0.005, [at[0], 0.31 + k * 0.016, at[2]], steel, wheel);
        cylinder(0.052, 0.02, [at[0], 0.292, at[2]], dark, wheel, 0.056);
        return;
      }
      const nut = mesh(new T.CylinderGeometry(0.052, 0.052, 0.055, 6), bright, wheel, [
        at[0],
        0.328,
        at[2],
      ]);
      nut.rotation.y = -angle;
      cylinder(0.052, 0.018, [at[0], 0.364, at[2]], bright, wheel, 0.034);
      cylinder(0.02, 0.012, [at[0], 0.377, at[2]], steel, wheel);
    },
    turn / spokes / 2,
  );
  const valve = new T.Group();
  atAngle(valve, 0.6, turn * 0.07, 0);
  wheel.add(valve);
  cylinder(0.017, 0.07, [0, 0.28, 0], rubber, valve);
  cylinder(0.014, 0.03, [0, 0.33, 0], steel, valve);

  const rotor = new T.Shape();
  around(80, (a, i) => {
    const x = Math.cos(a) * 0.582,
      y = Math.sin(a) * 0.582;
    if (i === 0) rotor.moveTo(x, y);
    else rotor.lineTo(x, y);
  });
  rotor.closePath();
  const hole = (x: number, y: number, r: number) => {
    const path = new T.Path();
    path.absarc(x, y, r, 0, turn, true);
    rotor.holes.push(path);
  };
  hole(0, 0, 0.21);
  around(12, (a) => {
    for (let j = 0; j < 3; j++) {
      const r = 0.405 + j * 0.059;
      hole(Math.cos(a + j * 0.09) * r, Math.sin(a + j * 0.09) * r, 0.016);
    }
  });
  const face = new T.ExtrudeGeometry(rotor, {
    depth: 0.017,
    bevelEnabled: false,
    curveSegments: 8,
  });
  face.rotateX(-Math.PI / 2);
  mesh(face, steel, wheel, [0, 0.022, 0]);
  mesh(face, steel, wheel, [0, -0.052, 0]);
  around(30, (angle) => {
    const vane = mesh(new T.BoxGeometry(0.14, 0.059, 0.019), barrel, wheel);
    atAngle(vane, 0.49, angle, -0.007);
    vane.rotation.y += 0.27;
  });
  cylinder(0.23, 0.16, [0, 0.105, 0], cast, wheel);
  const caliper = new T.Group();
  atAngle(caliper, 0.507, turn * 0.36, 0.014);
  axle.add(caliper);
  const enamel = metal(0xa02d24, 0.31, 0.47);
  for (const y of [-0.1, 0.087])
    mesh(new RoundedBoxGeometry(0.17, 0.09, 0.44, 1, 0.032), enamel, caliper, [0, y, 0]);
  for (const z of [-0.1, 0.1]) cylinder(0.065, 0.031, [-0.012, 0.141, z], enamel, caliper);
  for (const z of [-0.136, 0.136]) {
    mesh(new RoundedBoxGeometry(0.084, 0.2, 0.113, 1, 0.027), enamel, caliper, [0.08, 0, z]);
    bolt([0, 0.14, z], 0.025, caliper);
  }
  cylinder(0.49, 0.018, [0, -0.24, 0], cast, axle);

  batchAssemblies([root, wheel]);
  // At time 0 the bare stud sits at one o'clock, where a still frame shows it best.
  const rest = turn / spokes / 2 + Math.PI / 3;
  return {
    root,
    update: (time) => {
      wheel.rotation.y = rest - (time / period) * turn;
    },
    setEdge: (strength) => {
      edge.value = strength;
    },
    dispose() {
      sidewall.map?.dispose();
      w.dispose();
    },
  };
}
