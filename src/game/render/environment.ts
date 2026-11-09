// 视觉预设（P5 起，P6 整理）：主题、时间、天气在场景里的效果。只读关卡的设置，不影响模拟。取值不变：
// - 主题（grass / sand / snow）：地面、障碍、边缘的颜色（见 LevelView 的 THEME_COLORS）；水面的颜色也随主题。
// - 时间（day / dusk / night）：渐变天空、环境光和太阳（月亮）光的颜色、强度和高度。
// - 天气（clear / fog / rain）：雾（fog 浓、rain 淡、clear 只有很远处的空气透视）；rain 另有下落的雨丝。
// 地图边界外有一片水面作为装饰：只渲染，不参与碰撞和寻路。

import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  ShaderMaterial,
  SphereGeometry,
  type Scene,
} from 'three';
import type { Theme, TimeOfDay, VisualPreset, Weather } from '../level/gen/brief';

interface TimeLook {
  /** 天空：头顶、地平线、地平线以下。 */
  readonly skyTop: number;
  readonly skyHorizon: number;
  readonly skyBottom: number;
  readonly hemiSky: number;
  readonly hemiGround: number;
  readonly hemiIntensity: number;
  readonly sun: number;
  readonly sunIntensity: number;
  /**
   * 太阳的高度角（弧度）和方位角。方位角让光大致从出生时镜头的后方照过来（关卡出生时多半面向 +Z），
   * 看得见的一面不背光；影子落在物体的远侧。
   */
  readonly sunElevation: number;
  readonly sunAzimuth: number;
  readonly water: number;
}

export const TIME_LOOKS: Readonly<Record<TimeOfDay, TimeLook>> = {
  day: {
    skyTop: 0x5ea8f0,
    skyHorizon: 0xd7ecfb,
    skyBottom: 0xa9c9e2,
    hemiSky: 0xe6f3ff,
    hemiGround: 0x8a7a62,
    hemiIntensity: 2.5,
    sun: 0xfff1d9,
    sunIntensity: 2.6,
    sunElevation: 0.95,
    sunAzimuth: 2.45,
    water: 0x2f8fc4,
  },
  dusk: {
    skyTop: 0x41447a,
    skyHorizon: 0xf6a26b,
    skyBottom: 0x8a5e66,
    hemiSky: 0xffcfa6,
    hemiGround: 0x6a5070,
    hemiIntensity: 2.2,
    sun: 0xffa064,
    sunIntensity: 2.1,
    sunElevation: 0.32,
    sunAzimuth: 2.2,
    water: 0x3d5a86,
  },
  night: {
    skyTop: 0x05070f,
    skyHorizon: 0x1d2a4d,
    skyBottom: 0x111a30,
    hemiSky: 0x7e93cf,
    hemiGround: 0x1c2232,
    hemiIntensity: 1.4,
    sun: 0xaabfff,
    sunIntensity: 0.85,
    sunElevation: 0.85,
    sunAzimuth: -2.5,
    water: 0x15284a,
  },
};

/** 雾的远近（米）。clear 时只在很远处有一点空气透视，不挡视线。 */
export const WEATHER_FOG: Readonly<Record<Weather, { near: number; far: number } | null>> = {
  clear: null,
  fog: { near: 6, far: 34 },
  rain: { near: 14, far: 70 },
};

const THEME_WATER: Readonly<Record<Theme, number | null>> = { grass: null, sand: 0x2aa6b5, snow: 0x7fa9c6 };

const RAIN_DROPS = 1400;
const RAIN_BOX = { width: 36, height: 14 };
const RAIN_SPEED = 16;
const RAIN_STREAK = 0.42;

const SKY_VERTEX = `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const SKY_FRAGMENT = `
uniform vec3 top;
uniform vec3 horizon;
uniform vec3 bottom;
uniform vec3 center;
varying vec3 vWorld;
void main() {
  float h = normalize(vWorld - center).y;
  // 地平线以下在近处保持地平线的颜色（和远处的雾一致），再慢慢过渡到底色
  vec3 color = h > 0.0 ? mix(horizon, top, pow(h, 0.55)) : mix(horizon, bottom, smoothstep(0.0, 0.35, -h));
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface EnvironmentSnapshot {
  readonly theme: string;
  readonly time: string;
  readonly weather: string;
  readonly sky: string;
  readonly fog: { readonly near: number; readonly far: number } | null;
  readonly rain: boolean;
  readonly sunIntensity: number;
  readonly water: boolean;
  readonly shadows: boolean;
}

function mix(a: number, b: number, t: number): number {
  return new Color(a).lerp(new Color(b), t).getHex();
}

export class Environment {
  private readonly hemi: HemisphereLight | null;
  private readonly sun: DirectionalLight | null;
  private readonly rain: LineSegments;
  private readonly drops: Float32Array;
  private readonly sky: Mesh;
  private readonly skyMaterial: ShaderMaterial;
  private readonly skyUniforms = {
    top: { value: new Color() },
    horizon: { value: new Color() },
    bottom: { value: new Color() },
    center: { value: new Color(0, 0, 0) },
  };
  private readonly water: Mesh;
  private visual: VisualPreset = { theme: 'grass', time: 'day', weather: 'clear' };
  private span = 40;

  constructor(private readonly scene: Scene) {
    this.hemi = (scene.children.find((c) => (c as Partial<HemisphereLight>).isHemisphereLight === true) as HemisphereLight | undefined) ?? null;
    this.sun = (scene.children.find((c) => (c as Partial<DirectionalLight>).isDirectionalLight === true) as DirectionalLight | undefined) ?? null;

    this.skyMaterial = new ShaderMaterial({
      uniforms: this.skyUniforms,
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: BackSide,
      depthWrite: false,
      fog: false,
      // 天空按设定的颜色显示（只做色彩空间转换，不做色调映射）
      toneMapped: false,
    });
    this.sky = new Mesh(new SphereGeometry(170, 32, 16), this.skyMaterial);
    this.sky.name = 'sky';
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    // 地图外的水面：比地面低一点，地图内被地面挡住，只在边界外看得见
    this.water = new Mesh(new PlaneGeometry(420, 420), new MeshStandardMaterial({ color: 0x2f8fc4, roughness: 0.18, metalness: 0.15 }));
    this.water.name = 'water';
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = -0.6;
    this.water.receiveShadow = true;
    scene.add(this.water);

    // 雨丝：每一滴是一条短线（两个顶点），位置由固定的公式铺开（不用随机数，每次都一样）
    this.drops = new Float32Array(RAIN_DROPS * 6);
    for (let i = 0; i < RAIN_DROPS; i++) {
      const x = (((i * 7919) % 1000) / 1000) * RAIN_BOX.width - RAIN_BOX.width / 2;
      const y = (((i * 104729) % 1000) / 1000) * RAIN_BOX.height;
      const z = (((i * 1299709) % 1000) / 1000) * RAIN_BOX.width - RAIN_BOX.width / 2;
      this.drops.set([x, y, z, x + 0.04, y + RAIN_STREAK, z + 0.02], i * 6);
    }
    const geometry = new BufferGeometry();
    // BufferAttribute 直接用这个数组（Float32BufferAttribute 会复制一份，改 drops 就传不到渲染里）
    geometry.setAttribute('position', new BufferAttribute(this.drops, 3));
    this.rain = new LineSegments(geometry, new LineBasicMaterial({ color: 0xb9d3f2, transparent: true, opacity: 0.55 }));
    this.rain.name = 'rain';
    this.rain.visible = false;
    this.rain.frustumCulled = false;
    scene.add(this.rain);
  }

  /** 关卡的范围（米）：太阳阴影只覆盖这块区域，阴影更清楚。 */
  setLevelSize(width: number, depth: number): void {
    this.span = Math.max(width, depth);
    this.placeSun();
  }

  private placeSun(): void {
    const sun = this.sun;
    if (!sun) return;
    const look = TIME_LOOKS[this.visual.time];
    const distance = this.span * 1.2 + 20;
    sun.position.set(
      Math.cos(look.sunElevation) * Math.sin(look.sunAzimuth) * distance,
      Math.sin(look.sunElevation) * distance,
      Math.cos(look.sunElevation) * Math.cos(look.sunAzimuth) * distance,
    );
    sun.target.position.set(0, 0, 0);
    const half = this.span * 0.75 + 4;
    const camera = sun.shadow.camera;
    camera.left = -half;
    camera.right = half;
    camera.top = half;
    camera.bottom = -half;
    camera.near = 1;
    camera.far = distance * 2.2;
    camera.updateProjectionMatrix();
  }

  apply(visual: VisualPreset): void {
    this.visual = visual;
    const look = TIME_LOOKS[visual.time];
    const fog = WEATHER_FOG[visual.weather];
    // 起雾时天空也褪成雾的颜色，远处融成一片
    const haze = visual.weather === 'fog' ? 0.75 : visual.weather === 'rain' ? 0.45 : 0;
    const horizon = mix(look.skyHorizon, 0x9aa6b4, visual.weather === 'clear' ? 0 : 0.35);
    const top = mix(look.skyTop, horizon, haze);
    const bottom = mix(look.skyBottom, horizon, haze);
    this.skyUniforms.top.value.setHex(top);
    this.skyUniforms.horizon.value.setHex(horizon);
    this.skyUniforms.bottom.value.setHex(bottom);
    this.scene.background = new Color(horizon);
    if (this.hemi) {
      this.hemi.color.setHex(look.hemiSky);
      this.hemi.groundColor.setHex(look.hemiGround);
      this.hemi.intensity = look.hemiIntensity * (visual.weather === 'clear' ? 1 : 0.92);
    }
    if (this.sun) {
      this.sun.color.setHex(look.sun);
      this.sun.intensity = look.sunIntensity * (visual.weather === 'clear' ? 1 : visual.weather === 'fog' ? 0.6 : 0.7);
    }
    this.scene.fog = fog ? new Fog(horizon, fog.near, fog.far) : new Fog(horizon, 70, 165);
    const water = THEME_WATER[visual.theme] ?? look.water;
    (this.water.material as MeshStandardMaterial).color.setHex(visual.time === 'day' ? water : mix(water, look.water, 0.6));
    this.rain.visible = visual.weather === 'rain';
    this.placeSun();
  }

  /** 每帧：雨丝下落并跟着镜头所看的位置；天空跟着镜头。暂停时 dt 为 0。 */
  update(dt: number, focus: { readonly x: number; readonly y: number; readonly z: number }, cameraPosition?: { readonly x: number; readonly y: number; readonly z: number }): void {
    if (cameraPosition) {
      this.sky.position.set(cameraPosition.x, 0, cameraPosition.z);
      this.skyUniforms.center.value.setRGB(cameraPosition.x, 0, cameraPosition.z);
    }
    if (!this.rain.visible) return;
    this.rain.position.set(focus.x, focus.y - 2, focus.z);
    const position = this.rain.geometry.getAttribute('position');
    const fall = RAIN_SPEED * dt;
    for (let i = 0; i < RAIN_DROPS; i++) {
      let y = (this.drops[i * 6 + 1] ?? 0) - fall;
      if (y < 0) y += RAIN_BOX.height;
      this.drops[i * 6 + 1] = y;
      this.drops[i * 6 + 4] = y + RAIN_STREAK;
    }
    position.needsUpdate = true;
  }

  /** 雨丝的当前位置（局部坐标，测试用）。 */
  rainPositions(): Float32Array {
    return this.rain.geometry.getAttribute('position').array as Float32Array;
  }

  snapshot(): EnvironmentSnapshot {
    const fog = WEATHER_FOG[this.visual.weather];
    return {
      theme: this.visual.theme,
      time: this.visual.time,
      weather: this.visual.weather,
      sky: `#${(this.scene.background as Color).getHexString()}`,
      fog: fog ? { near: fog.near, far: fog.far } : null,
      rain: this.rain.visible,
      sunIntensity: this.sun?.intensity ?? 0,
      water: this.water.visible,
      shadows: this.sun?.castShadow ?? false,
    };
  }
}
