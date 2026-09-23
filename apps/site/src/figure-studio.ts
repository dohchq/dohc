import * as T from 'three';
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js';

/** The page's two figures share one studio: the same exposure, reflections
 * and key light from the upper left, so both models sit on the paper the
 * same way. The cast shadow falls down and to the right; a soft contact
 * shadow, baked once from below, grounds the model where it meets the page. */
export interface FigureStudio {
  center: T.Vector3;
  radius: number;
  setDark: (dark: boolean) => void;
  dispose: () => void;
}

const shadowOpacity = { light: { cast: 0.08, contact: 0.55 }, dark: { cast: 0.3, contact: 0.8 } };

export function stageFigure(renderer: T.WebGLRenderer, scene: T.Scene, figure: T.Object3D, studio: T.DataTexture, { animated = false } = {}): FigureStudio {
  renderer.setClearColor(0, 0);
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.VSMShadowMap;
  renderer.shadowMap.autoUpdate = animated;
  renderer.shadowMap.needsUpdate = true;

  scene.add(figure);
  figure.updateMatrixWorld(true);
  const box = new T.Box3().setFromObject(figure);
  const center = box.getCenter(new T.Vector3());
  const size = box.getSize(new T.Vector3());
  const radius = box.getBoundingSphere(new T.Sphere()).radius;

  const pmrem = new T.PMREMGenerator(renderer);
  const environment = pmrem.fromEquirectangular(studio);
  pmrem.dispose();
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.8;
  scene.environmentRotation.y = 0.75;

  scene.add(new T.HemisphereLight(0xf2f4f8, 0x8a8174, 0.35));
  const key = new T.DirectionalLight(0xfff6ec, 1.5);
  key.position.copy(center).addScaledVector(new T.Vector3(-0.22, 1, 0.3).normalize(), radius * 3);
  key.target.position.copy(center);
  key.castShadow = true;
  key.shadow.mapSize.set(512, 512);
  Object.assign(key.shadow.camera, { left: -radius * 1.4, right: radius * 1.4, top: radius * 1.4, bottom: -radius * 1.4, near: radius * 0.5, far: radius * 5 });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.normalBias = 0.02;
  key.shadow.bias = -0.0001;
  key.shadow.radius = 10;
  key.shadow.blurSamples = 16;
  scene.add(key, key.target);
  const fill = new T.DirectionalLight(0xdfe8ff, 0.5);
  fill.position.copy(center).add(new T.Vector3(radius * 2, radius * 0.6, -radius * 1.2));
  scene.add(fill);

  const groundY = box.min.y - 0.01;
  const groundGeometry = new T.PlaneGeometry(radius * 8, radius * 8).rotateX(-Math.PI / 2);
  const castMaterial = new T.ShadowMaterial({ depthWrite: false });
  const ground = new T.Mesh(groundGeometry, castMaterial);
  ground.position.y = groundY;
  ground.receiveShadow = true;
  scene.add(ground);

  // Contact shadow: render the model's underside from the floor looking up,
  // darker where parts come closer to the floor, then blur it twice.
  const width = size.x + radius * 0.6;
  const depth = size.z + radius * 0.6;
  const reach = size.y * 0.3;
  const target = new T.WebGLRenderTarget(512, 512);
  const blurTarget = new T.WebGLRenderTarget(512, 512);
  const floorCamera = new T.OrthographicCamera(-width / 2, width / 2, depth / 2, -depth / 2, 0, reach);
  floorCamera.position.set(center.x, groundY, center.z);
  floorCamera.rotation.x = Math.PI / 2;
  floorCamera.updateMatrixWorld();
  const depthMaterial = new T.MeshDepthMaterial();
  depthMaterial.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace(
      'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
      'gl_FragColor = vec4( vec3( 0.0 ), pow( 1.0 - fragCoordZ, 1.6 ) );',
    );
  };
  const quad = new T.Mesh(new T.PlaneGeometry(2, 2));
  const quadCamera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  quadCamera.position.z = 0.5;
  const horizontal = new T.ShaderMaterial({ ...HorizontalBlurShader, uniforms: T.UniformsUtils.clone(HorizontalBlurShader.uniforms) });
  const vertical = new T.ShaderMaterial({ ...VerticalBlurShader, uniforms: T.UniformsUtils.clone(VerticalBlurShader.uniforms) });
  horizontal.depthTest = vertical.depthTest = false;
  const blur = (amount: number) => {
    quad.material = horizontal;
    horizontal.uniforms.tDiffuse.value = target.texture;
    horizontal.uniforms.h.value = amount / 256;
    renderer.setRenderTarget(blurTarget);
    renderer.render(quad, quadCamera);
    quad.material = vertical;
    vertical.uniforms.tDiffuse.value = blurTarget.texture;
    vertical.uniforms.v.value = amount / 256;
    renderer.setRenderTarget(target);
    renderer.render(quad, quadCamera);
  };
  const contactMaterial = new T.MeshBasicMaterial({ map: target.texture, color: 0x000000, transparent: true, depthWrite: false });
  // The floor camera sees +z at the top of its image, so the plane faces up with v along +z.
  const contact = new T.Mesh(new T.PlaneGeometry(width, depth).rotateX(Math.PI / 2), contactMaterial);
  contact.scale.y = -1;
  contact.position.set(center.x, groundY + 0.002, center.z);
  contact.renderOrder = 1;
  ground.visible = false;
  scene.overrideMaterial = depthMaterial;
  renderer.setRenderTarget(target);
  renderer.render(scene, floorCamera);
  scene.overrideMaterial = null;
  ground.visible = true;
  blur(1.4);
  blur(0.6);
  renderer.setRenderTarget(null);
  // The bake ran with the floor hidden; draw the cast shadow again with it in place.
  renderer.shadowMap.needsUpdate = true;
  blurTarget.dispose();
  depthMaterial.dispose(); horizontal.dispose(); vertical.dispose(); quad.geometry.dispose();
  scene.add(contact);

  const setDark = (dark: boolean) => {
    const opacity = dark ? shadowOpacity.dark : shadowOpacity.light;
    castMaterial.opacity = opacity.cast;
    contactMaterial.opacity = opacity.contact;
  };
  setDark(false);

  return {
    center,
    radius,
    setDark,
    dispose() {
      environment.dispose();
      key.shadow.dispose();
      target.dispose();
      groundGeometry.dispose();
      castMaterial.dispose();
      contact.geometry.dispose();
      contactMaterial.dispose();
    },
  };
}

