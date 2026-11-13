import * as T from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { batchAssemblies, workshop, type DriveModel } from "./drive-models";

const turn = Math.PI * 2;
const spokes = 5;

/** A five-spoke road wheel with one lug nut missing, standing upright with
 * its face toward +z. It turns on its axle once every `period` seconds. */
export function createWheel(period = 14): DriveModel & { setEdge: (strength: number) => void } {
  const w = workshop();
  const { root, metal, silver, bright, steel, dark, cast, brass, mesh, cylinder, ring, bolt } = w;
  const rubber = metal(0x1e2124, 0.86, 0);
  const sidewall = metal(0x2a2e32, 0.74, 0);
  const barrel = metal(0x8a939b, 0.45, 0.85);
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
    segments = 128,
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

  // Tire: a rounded casing, then raised tread blocks in four staggered rows.
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
  ring(0.8, 0.012, [0, 0.335, 0], sidewall, wheel);
  const pitch = turn / 64;
  for (const [y, depth, offset] of [
    [-0.205, 0.13, 0],
    [-0.06, 0.1, 0.5],
    [0.06, 0.1, 0],
    [0.205, 0.13, 0.5],
  ]) {
    around(
      64,
      (angle) => {
        const block = mesh(new RoundedBoxGeometry(0.026, depth, 0.07, 1, 0.01), rubber, wheel);
        atAngle(block, 0.981, angle, y);
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
      [0.33, 0.16],
      [0.35, 0.2],
      [0.34, 0.275],
      [0.3, 0.3],
      [0.06, 0.3],
    ],
    silver,
  );
  // Five spokes, wide at the hub and flaring a little where they meet the rim.
  const outline = new T.Shape(
    [
      [0.26, -0.105],
      [0.5, -0.06],
      [0.64, -0.085],
      [0.665, 0],
      [0.64, 0.085],
      [0.5, 0.06],
      [0.26, 0.105],
    ].map(([x, y]) => new T.Vector2(x, y)),
  );
  const spoke = new T.ExtrudeGeometry(outline, {
    depth: 0.05,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.018,
    bevelSegments: 2,
    curveSegments: 4,
  });
  spoke.rotateX(-Math.PI / 2).translate(0, 0.21, 0);
  around(spokes, (angle) => {
    mesh(spoke.clone(), silver, wheel).rotation.y = -angle;
  });
  spoke.dispose();
  // Center cap.
  lathe(
    [
      [0.112, 0.3],
      [0.11, 0.31],
      [0.09, 0.33],
      [0.05, 0.342],
      [0, 0.345],
    ],
    bright,
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
  // Valve stem, beside a spoke at the rim.
  const valve = new T.Group();
  atAngle(valve, 0.6, turn * 0.07, 0);
  wheel.add(valve);
  cylinder(0.017, 0.07, [0, 0.28, 0], rubber, valve);
  cylinder(0.014, 0.03, [0, 0.33, 0], steel, valve);

  // Brake disc and its hat turn with the wheel, behind the spokes.
  const disc = [
    [0.22, -0.06],
    [0.56, -0.06],
    [0.56, 0.02],
    [0.22, 0.02],
  ];
  disc.forEach((point, i) => lathe([point, disc[(i + 1) % disc.length]], steel, wheel, 96));
  around(30, (angle, i) => {
    const hole = cylinder(0.012, 0.004, [0, 0, 0], dark, wheel);
    atAngle(hole, i % 2 ? 0.4 : 0.48, angle, 0.022);
  });
  cylinder(0.21, 0.14, [0, 0.1, 0], cast, wheel);

  // The caliper and backing plate stay put while the wheel turns.
  const caliper = new T.Group();
  atAngle(caliper, 0.55, turn * 0.36, -0.02);
  axle.add(caliper);
  mesh(new RoundedBoxGeometry(0.13, 0.19, 0.36, 2, 0.035), brass, caliper);
  for (const z of [-0.12, 0.12]) bolt([0.02, 0.1, z], 0.022, caliper);
  cylinder(0.6, 0.02, [0, -0.24, 0], cast, axle);

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
    dispose: w.dispose,
  };
}
