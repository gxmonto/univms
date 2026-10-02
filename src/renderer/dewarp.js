// Client-side fisheye dewarping with WebGL: 360° panorama strip or a virtual PTZ view, for any camera
// (Hikvision/DW fisheye models or generic 180°+ lenses). Parameters: image circle center/radius and mount.
const VS = `attribute vec2 p; varying vec2 uv; void main(){ uv = vec2(p.x*0.5+0.5, 0.5-p.y*0.5); gl_Position = vec4(p,0.0,1.0); }`;
const FS = `
precision highp float;
varying vec2 uv;
uniform sampler2D tex;
uniform int mode;          // 1 = panorama, 2 = virtual ptz
uniform vec2 center;       // image circle center (0..1, 0..1)
uniform float radius;      // image circle radius as fraction of image width
uniform float aspect;      // image width / height
uniform float pan, tilt, fov;
uniform float flipY;       // 1 = ceiling (default), -1 = table/wall
const float PI = 3.14159265;
void main() {
  vec2 src;
  if (mode == 1) {
    float theta = uv.x * 2.0 * PI + pan;
    float rho = mix(1.0, 0.08, uv.y);                 // top of the strip = outer edge (horizon)
    src = center + vec2(cos(theta), sin(theta) * aspect * flipY) * radius * rho;
  } else {
    float t = tan(fov * 0.5);
    vec3 d = normalize(vec3((uv.x - 0.5) * 2.0 * t, (0.5 - uv.y) * 2.0 * t / 1.7778, 1.0));
    // tilt around X, then pan around the optical axis Z
    float ct = cos(tilt), st = sin(tilt);
    d = vec3(d.x, d.y * ct - d.z * st, d.y * st + d.z * ct);
    float cp = cos(pan), sp = sin(pan);
    d = vec3(d.x * cp - d.y * sp, d.x * sp + d.y * cp, d.z);
    if (d.z <= 0.0) { gl_FragColor = vec4(0.0,0.0,0.0,1.0); return; }
    float phi = acos(clamp(d.z, -1.0, 1.0));           // angle from optical axis
    float rho = phi / (PI * 0.5);                       // equidistant lens, 180° FOV -> rho 1 at the edge
    if (rho > 1.0) { gl_FragColor = vec4(0.0,0.0,0.0,1.0); return; }
    float theta = atan(d.y, d.x);
    src = center + vec2(cos(theta), sin(theta) * aspect * flipY) * radius * rho;
  }
  if (src.x < 0.0 || src.x > 1.0 || src.y < 0.0 || src.y > 1.0) { gl_FragColor = vec4(0.0,0.0,0.0,1.0); return; }
  gl_FragColor = texture2D(tex, src);
}`;

export const DEFAULT_DEWARP = { mode: 'off', cx: 0.5, cy: 0.5, r: 0.5, mount: 'ceiling', pan: 0, tilt: 0.6, fov: 1.4 };

export class Dewarper {
  constructor(video, canvas, params = {}) {
    this.video = video; this.canvas = canvas;
    this.p = { ...DEFAULT_DEWARP, ...params };
    this.gl = null; this.raf = 0; this.running = false;
  }
  init() {
    const gl = this.canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error('WebGL not available');
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.u = {}; for (const n of ['mode', 'center', 'radius', 'aspect', 'pan', 'tilt', 'fov', 'flipY']) this.u[n] = gl.getUniformLocation(prog, n);
    this.gl = gl;
  }
  start() {
    if (!this.gl) this.init();
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }
  stop() { this.running = false; cancelAnimationFrame(this.raf); }
  set(patch) { Object.assign(this.p, patch); }
  draw() {
    const gl = this.gl, v = this.video;
    if (!gl || !v.videoWidth) return;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; gl.viewport(0, 0, w, h); }
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, v); } catch (_) { return; }
    const p = this.p;
    gl.uniform1i(this.u.mode, p.mode === 'panorama' ? 1 : 2);
    gl.uniform2f(this.u.center, p.cx, p.cy);
    gl.uniform1f(this.u.radius, p.r);
    gl.uniform1f(this.u.aspect, v.videoWidth / v.videoHeight);
    gl.uniform1f(this.u.pan, p.pan); gl.uniform1f(this.u.tilt, p.tilt); gl.uniform1f(this.u.fov, p.fov);
    gl.uniform1f(this.u.flipY, p.mount === 'ceiling' ? 1 : -1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  snapshotDataUrl() { this.draw(); return this.canvas.toDataURL('image/jpeg', 0.92); }
}
