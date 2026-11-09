import * as T from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { batchAssemblies, workshop, type DriveModel } from './drive-models';

const turn = Math.PI * 2;
const spokes = 5;

/** A five-spoke road wheel with one lug nut missing, standing upright with
 * its face toward +z. It turns on its axle once every `period` seconds. */
export function createWheel(period = 14): DriveModel & { setEdge: (strength: number) => void } {
  const w = workshop();
  const { root, metal, silver, bright, steel, dark, cast, brass, mesh, cylinder, ring, bolt } = w;
  const rubber = metal(0x1e2124, .86, 0);
  const sidewall = metal(0x2a2e32, .74, 0);
  const barrel = metal(0x8a939b, .45, .85);
  barrel.side = T.DoubleSide;
  // A glow at the tire's edges, so a black tire still reads against a dark page.
  const edge = { value: 0 };
  for (const material of [rubber, sidewall]) material.onBeforeCompile = shader => {
    shader.uniforms.edge = edge;
    shader.fragmentShader = `uniform float edge;\n${shader.fragmentShader.replace('#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\ntotalEmissiveRadiance += edge * pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);')}`;
  };
  // Local +y is the axle; the group turns it toward the viewer.
  const axle = new T.Group(); axle.rotation.x = Math.PI / 2; root.add(axle);
  const wheel = new T.Group(); axle.add(wheel);
  const lathe = (points: number[][], material: T.Material, parent: T.Object3D = wheel, segments = 128) =>
    mesh(new T.LatheGeometry(points.map(([r, y]) => new T.Vector2(r, y)), segments), material, parent);
  const around = (count: number, place: (angle: number, i: number) => void, offset = 0) => {
    for (let i = 0; i < count; i++) place(offset + i * turn / count, i);
  };
  const atAngle = (part: T.Object3D, radius: number, angle: number, y: number) => {
    part.position.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
    part.rotation.y = -angle;
    return part;
  };

  // Tire: a rounded casing, then raised tread blocks in four staggered rows.
  const casing = new T.SplineCurve([[.7, -.29], [.8, -.335], [.9, -.35], [.955, -.325], [.97, -.27]]
    .map(([r, y]) => new T.Vector2(r, y))).getPoints(16);
  lathe(casing.map(p => [p.x, p.y]), sidewall);
  lathe([[.97, -.27], [.97, .27]], rubber);
  lathe(casing.map(p => [p.x, -p.y]).reverse(), sidewall);
  ring(.8, .012, [0, .335, 0], sidewall, wheel);
  const pitch = turn / 64;
  for (const [y, depth, offset] of [[-.205, .13, 0], [-.06, .1, .5], [.06, .1, 0], [.205, .13, .5]]) {
    around(64, angle => {
      const block = mesh(new RoundedBoxGeometry(.026, depth, .07, 1, .01), rubber, wheel);
      atAngle(block, .981, angle, y);
    }, offset * pitch);
  }

  // Rim: a bright front flange, the barrel seen through the spokes, a hub pad.
  lathe([[.735, -.31], [.68, -.29], [.665, .24], [.705, .27], [.74, .305], [.725, .325], [.69, .305], [.64, .27]], barrel);
  ring(.712, .022, [0, .305, 0], bright, wheel);
  lathe([[.33, .16], [.35, .2], [.34, .275], [.3, .3], [.06, .3]], silver);
  // Five spokes, wide at the hub and flaring a little where they meet the rim.
  const outline = new T.Shape([[.26, -.105], [.5, -.06], [.64, -.085], [.665, 0], [.64, .085], [.5, .06], [.26, .105]]
    .map(([x, y]) => new T.Vector2(x, y)));
  const spoke = new T.ExtrudeGeometry(outline, { depth: .05, bevelEnabled: true, bevelThickness: .02, bevelSize: .018, bevelSegments: 2, curveSegments: 4 });
  spoke.rotateX(-Math.PI / 2).translate(0, .21, 0);
  around(spokes, angle => { mesh(spoke.clone(), silver, wheel).rotation.y = -angle; });
  spoke.dispose();
  // Center cap.
  lathe([[.112, .3], [.11, .31], [.09, .33], [.05, .342], [0, .345]], bright, wheel, 48);

  // Lug studs between the spokes. The first has no nut: its bare thread and
  // the dark seat show where the nut was.
  around(spokes, (angle, i) => {
    const at = [Math.cos(angle) * .23, 0, Math.sin(angle) * .23];
    if (i === 0) {
      cylinder(.02, .1, [at[0], .345, at[2]], steel, wheel);
      for (let k = 0; k < 5; k++) ring(.02, .005, [at[0], .31 + k * .016, at[2]], steel, wheel);
      cylinder(.052, .02, [at[0], .292, at[2]], dark, wheel, .056);
      return;
    }
    const nut = mesh(new T.CylinderGeometry(.052, .052, .055, 6), bright, wheel, [at[0], .328, at[2]]);
    nut.rotation.y = -angle;
    cylinder(.052, .018, [at[0], .364, at[2]], bright, wheel, .034);
    cylinder(.02, .012, [at[0], .377, at[2]], steel, wheel);
  }, turn / spokes / 2);
  // Valve stem, beside a spoke at the rim.
  const valve = new T.Group(); atAngle(valve, .6, turn * .07, 0); wheel.add(valve);
  cylinder(.017, .07, [0, .28, 0], rubber, valve);
  cylinder(.014, .03, [0, .33, 0], steel, valve);

  // Brake disc and its hat turn with the wheel, behind the spokes.
  const disc = [[.22, -.06], [.56, -.06], [.56, .02], [.22, .02]];
  disc.forEach((point, i) => lathe([point, disc[(i + 1) % disc.length]], steel, wheel, 96));
  around(30, (angle, i) => {
    const hole = cylinder(.012, .004, [0, 0, 0], dark, wheel);
    atAngle(hole, i % 2 ? .4 : .48, angle, .022);
  });
  cylinder(.21, .14, [0, .1, 0], cast, wheel);

  // The caliper and backing plate stay put while the wheel turns.
  const caliper = new T.Group(); atAngle(caliper, .55, turn * .36, -.02); axle.add(caliper);
  mesh(new RoundedBoxGeometry(.13, .19, .36, 2, .035), brass, caliper);
  for (const z of [-.12, .12]) bolt([.02, .1, z], .022, caliper);
  cylinder(.6, .02, [0, -.24, 0], cast, axle);

  batchAssemblies([root, wheel]);
  // At time 0 the bare stud sits at one o'clock, where a still frame shows it best.
  const rest = turn / spokes / 2 + Math.PI / 3;
  return {
    root,
    update: time => { wheel.rotation.y = rest - time / period * turn; },
    setEdge: strength => { edge.value = strength; },
    dispose: w.dispose,
  };
}
