import { BufferGeometry, Matrix4 } from "three";

export function transformedGeometry(source: BufferGeometry, matrix: Matrix4) {
  const geometry = source.clone();
  if (!geometry.index) {
    const count = geometry.getAttribute("position").count;
    geometry.setIndex(Array.from({ length: count }, (_, i) => i));
  }
  return geometry.applyMatrix4(matrix);
}
