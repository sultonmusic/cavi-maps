/* WebGL helpers shared by the map's custom 3D layers: the solid program that draws coloured
   triangles (roofs, trees, street furniture, the location arrow, landmarks) and the textured
   program that lays facade decals over the extruded houses.

   Both are GLSL ES 1.00, so they run on the WebGL1 fallback as well as on WebGL2. */
import type { MercatorCoordinate } from 'maplibre-gl'

export type GL = WebGLRenderingContext | WebGL2RenderingContext
export type SolidProgram = { program: WebGLProgram; matrix: WebGLUniformLocation | null; point: number; colour: number }
export type TexturedProgram = {
  program: WebGLProgram
  matrix: WebGLUniformLocation | null; image: WebGLUniformLocation | null
  fade: WebGLUniformLocation | null; opacity: WebGLUniformLocation | null
  point: number; uvs: number
}

function link(gl: GL, vertex: string, fragment: string): WebGLProgram | null {
  const program = gl.createProgram()
  if (!program) return null
  for (const [kind, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
    const shader = gl.createShader(kind)
    if (!shader) return null
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    gl.attachShader(program, shader)
  }
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); return null }
  return program
}

/** The one program behind the hand-drawn 3D layers: triangles of x, y, z and premultiplied r, g, b, a. */
export function solidProgram(gl: GL): SolidProgram | null {
  const program = link(gl,
    'uniform mat4 u_matrix;attribute vec3 a_point;attribute vec4 a_colour;varying vec4 v_colour;void main(){gl_Position=u_matrix*vec4(a_point,1.0);v_colour=a_colour;}',
    'precision mediump float;varying vec4 v_colour;void main(){gl_FragColor=v_colour;}')
  if (!program) return null
  return { program, matrix: gl.getUniformLocation(program, 'u_matrix'), point: gl.getAttribLocation(program, 'a_point'), colour: gl.getAttribLocation(program, 'a_colour') }
}

/** Composed in 64-bit before the upload, or building-sized objects twitch at street zooms. */
export function composeMatrix(view: ArrayLike<number>, model: number[]) {
  const matrix = new Float32Array(16)
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    let sum = 0
    for (let k = 0; k < 4; k++) sum += view[row + k * 4] * model[k + column * 4]
    matrix[row + column * 4] = sum
  }
  return matrix
}

export function bindSolid(gl: GL, solid: SolidProgram, buffer: WebGLBuffer | null, matrix: Float32Array) {
  gl.useProgram(solid.program)
  gl.uniformMatrix4fv(solid.matrix, false, matrix)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.enableVertexAttribArray(solid.point)
  gl.enableVertexAttribArray(solid.colour)
  gl.vertexAttribPointer(solid.point, 3, gl.FLOAT, false, 28, 0)
  gl.vertexAttribPointer(solid.colour, 4, gl.FLOAT, false, 28, 12)
}

export function unbindSolid(gl: GL, solid: SolidProgram) {
  gl.disableVertexAttribArray(solid.point)
  gl.disableVertexAttribArray(solid.colour)
}

/** East, north and up in metres from `origin`, into mercator units whose y grows southwards. */
export function metreModel(origin: MercatorCoordinate): number[] {
  const s = origin.meterInMercatorCoordinateUnits()
  return [s, 0, 0, 0, 0, -s, 0, 0, 0, 0, s, 0, origin.x, origin.y, 0, 1]
}

/** Textured decals: x, y, z in local metres, then u, v and a light factor for the texture's colour.
    `u_fade` is a circle (x, y, radius in metres) outside which the decals fade over their last 40 m,
    and `u_opacity` fades them all in with the zoom. Textures hold premultiplied colour. */
export function texturedProgram(gl: GL): TexturedProgram | null {
  const program = link(gl,
    'uniform mat4 u_matrix;attribute vec3 a_point;attribute vec3 a_uvs;varying vec3 v_uvs;varying vec2 v_xy;void main(){gl_Position=u_matrix*vec4(a_point,1.0);v_uvs=a_uvs;v_xy=a_point.xy;}',
    'precision mediump float;uniform sampler2D u_image;uniform vec3 u_fade;uniform float u_opacity;varying vec3 v_uvs;varying vec2 v_xy;'
    + 'void main(){vec4 t=texture2D(u_image,v_uvs.xy);float keep=u_opacity*(1.0-smoothstep(u_fade.z-40.0,u_fade.z,length(v_xy-u_fade.xy)));gl_FragColor=vec4(t.rgb*v_uvs.z,t.a)*keep;}')
  if (!program) return null
  return {
    program,
    matrix: gl.getUniformLocation(program, 'u_matrix'), image: gl.getUniformLocation(program, 'u_image'),
    fade: gl.getUniformLocation(program, 'u_fade'), opacity: gl.getUniformLocation(program, 'u_opacity'),
    point: gl.getAttribLocation(program, 'a_point'), uvs: gl.getAttribLocation(program, 'a_uvs'),
  }
}

/** Six floats a vertex: x, y, z, then u, v and shade. The texture is read from unit 0. */
export function bindTextured(gl: GL, textured: TexturedProgram, buffer: WebGLBuffer | null, matrix: Float32Array) {
  gl.useProgram(textured.program)
  gl.uniformMatrix4fv(textured.matrix, false, matrix)
  gl.uniform1i(textured.image, 0)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.enableVertexAttribArray(textured.point)
  gl.enableVertexAttribArray(textured.uvs)
  gl.vertexAttribPointer(textured.point, 3, gl.FLOAT, false, 24, 0)
  gl.vertexAttribPointer(textured.uvs, 3, gl.FLOAT, false, 24, 12)
}

export function unbindTextured(gl: GL, textured: TexturedProgram) {
  gl.disableVertexAttribArray(textured.point)
  gl.disableVertexAttribArray(textured.uvs)
}
