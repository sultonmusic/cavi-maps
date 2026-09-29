/* The facade decals' textures, painted pixel by pixel so they need no canvas (node checks and
   previews use the same pixels) and uploaded straight as premultiplied RGBA.

   Every texture is a power of two, so WebGL1 can repeat it and build mipmaps. A wall texture is
   one window bay wide and one 3 m floor tall: row 0 is the ceiling of the floor, the last row its
   floor slab; column 0 the start of the bay. Transparent pixels let the extruded wall show. */
import type { GL } from './gl-kit'
import { TEXTURE_NAMES, type TextureName } from './facades.mjs'

/** Premultiplied RGBA bytes, row 0 first. */
export type Pixels = { width: number; height: number; data: Uint8Array }
type RGBA = [number, number, number, number]
/** A colour, or a colour per row (every gradient here runs top to bottom). */
type Paint = RGBA | ((row: number) => RGBA)

const hex = (value: string, alpha = 1): RGBA => [1, 3, 5].map(at => parseInt(value.slice(at, at + 2), 16) / 255).concat(alpha) as RGBA
const rgba = (r: number, g: number, b: number, a: number): RGBA => [r / 255, g / 255, b / 255, a]
const mix = (a: RGBA, b: RGBA, t: number): RGBA => [0, 1, 2, 3].map(i => a[i] + (b[i] - a[i]) * t) as RGBA

/** A picture of premultiplied floats with source-over painting of inclusive pixel boxes. */
function picture(width: number, height: number) {
  const floats = new Float32Array(width * height * 4)
  return {
    width, height,
    fill(fromColumn: number, fromRow: number, toColumn: number, toRow: number, paint: Paint) {
      for (let row = Math.max(0, fromRow); row <= Math.min(height - 1, toRow); row++) {
        const [r, g, b, a] = typeof paint === 'function' ? paint(row) : paint, keep = 1 - a
        for (let column = Math.max(0, fromColumn); column <= Math.min(width - 1, toColumn); column++) {
          const at = (row * width + column) * 4
          floats[at] = r * a + floats[at] * keep
          floats[at + 1] = g * a + floats[at + 1] * keep
          floats[at + 2] = b * a + floats[at + 2] * keep
          floats[at + 3] = a + floats[at + 3] * keep
        }
      }
    },
    /** Darkens a box by `factor`, keeping its alpha: the shade under a lintel. */
    shade(fromColumn: number, fromRow: number, toColumn: number, toRow: number, factor: number) {
      for (let row = fromRow; row <= toRow; row++) for (let column = fromColumn; column <= toColumn; column++) {
        const at = (row * width + column) * 4
        for (let i = 0; i < 3; i++) floats[at + i] *= factor
      }
    },
    pixels(): Pixels {
      const data = new Uint8Array(floats.length)
      for (let i = 0; i < floats.length; i++) data[i] = Math.round(Math.min(1, Math.max(0, floats[i])) * 255)
      return { width, height, data }
    },
  }
}

/** A vertical gradient between two colours over rows `from` to `to`. */
const gradient = (top: string, bottom: string, from: number, to: number) => {
  const a = hex(top), b = hex(bottom)
  return (row: number): RGBA => mix(a, b, Math.min(1, Math.max(0, (row - from) / Math.max(1, to - from))))
}

/** A framed window: frame, glass inset 4 px with a gradient, a mullion down the middle, an
    optional transom, and the lintel's shade over the top rows of glass. */
function framedWindow(p: ReturnType<typeof picture>, left: number, top: number, right: number, bottom: number, frame: string, glassTop: string, glassBottom: string, transom?: number) {
  p.fill(left, top, right, bottom, hex(frame))
  p.fill(left + 4, top + 4, right - 4, bottom - 4, gradient(glassTop, glassBottom, top + 4, bottom - 4))
  const middle = Math.round((left + right) / 2)
  p.fill(middle - 2, top + 4, middle + 1, bottom - 4, hex(frame))
  if (transom !== undefined) p.fill(left + 4, transom, right - 4, transom + 2, hex(frame))
  p.shade(left + 4, top + 4, right - 4, top + 6, 0.86)
}

/** A deterministic 0..1 value per pixel, for the roof's grit. */
const grain = (row: number, column: number) => {
  let h = Math.imul(row * 374761393 + column * 668265263, 1274126177)
  h ^= h >>> 13; h = Math.imul(h, 1274126177); h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

export function facadePixels(name: TextureName): Pixels {
  switch (name) {
    case 'block': {
      const p = picture(128, 128)
      p.fill(0, 122, 127, 127, rgba(90, 85, 78, 0.10))
      framedWindow(p, 34, 30, 94, 100, '#fafaf8', '#cfe0ec', '#9fbad0', 52)
      p.fill(30, 100, 98, 104, hex('#d8d3cb'))
      return p.pixels()
    }
    case 'house': {
      const p = picture(128, 128)
      framedWindow(p, 40, 36, 88, 96, '#f7f5f0', '#c7d9e6', '#a5bfd2')
      p.fill(36, 96, 92, 99, hex('#ddd6cb'))
      p.fill(0, 116, 127, 127, rgba(70, 60, 50, 0.18))
      return p.pixels()
    }
    case 'office': {
      const p = picture(128, 128)
      p.fill(0, 0, 127, 127, hex('#dde3e8'))
      p.fill(4, 10, 124, 100, gradient('#bcd3e4', '#8eaec8', 10, 100))
      p.shade(4, 10, 124, 13, 0.88)
      p.fill(0, 0, 4, 127, hex('#e9eef2'))
      p.fill(124, 0, 127, 127, hex('#e9eef2'))
      return p.pixels()
    }
    case 'shop': {
      const p = picture(128, 128)
      p.fill(0, 8, 127, 30, hex('#e4ded4'))
      p.fill(0, 30, 127, 32, hex('#9a948b'))
      p.fill(6, 34, 122, 114, gradient('#8fb0c6', '#6f93ab', 34, 114))
      p.shade(6, 34, 122, 38, 0.85)
      p.fill(0, 33, 6, 115, hex('#5d6469'))
      p.fill(122, 33, 127, 115, hex('#5d6469'))
      p.fill(0, 116, 127, 127, hex('#b8b0a4'))
      return p.pixels()
    }
    case 'hall': {
      const p = picture(128, 128)
      p.fill(0, 14, 127, 46, hex('#b3c8d8'))
      p.shade(0, 14, 127, 16, 0.86)
      for (let column = 0; column < 128; column += 32) p.fill(column, 14, column + 1, 46, hex('#e6e9ec'))
      p.fill(0, 118, 127, 127, rgba(70, 60, 50, 0.18))
      return p.pixels()
    }
    case 'door': {
      const p = picture(64, 128)
      p.fill(0, 0, 63, 127, hex('#5a6166'))
      p.fill(6, 8, 57, 127, gradient('#7d98ad', '#5f7a8f', 8, 127))
      p.fill(31, 8, 32, 127, hex('#4c5358'))
      p.fill(0, 0, 63, 8, rgba(0, 0, 0, 0.25))
      return p.pixels()
    }
    case 'roof': {
      const p = picture(128, 128), base = hex('#cfccc6'), seam = hex('#c2beb7')
      p.fill(0, 0, 127, 127, base)
      for (let at = 0; at < 128; at += 32) { p.fill(at, 0, at, 127, seam); p.fill(0, at, 127, at, seam) }
      // 300 specks of grit a few per cent lighter or darker.
      for (let k = 0; k < 300; k++) {
        const row = Math.floor(grain(k, 1) * 128), column = Math.floor(grain(k, 2) * 128), change = 1 + (grain(k, 3) * 2 - 1) * 0.04
        p.shade(column, row, column, row, change)
      }
      return p.pixels()
    }
    case 'shadow': {
      const p = picture(8, 64)
      p.fill(0, 0, 7, 63, (row: number) => [0, 0, 0, 0.22 * (1 - row / 63) ** 2])
      return p.pixels()
    }
  }
}

/** Every texture's pixels, indexed by TEXTURE. */
export const paintFacades = (): Pixels[] => TEXTURE_NAMES.map(facadePixels)

/** Uploads every texture, indexed by TEXTURE, from pixels painted beforehand (painting takes a
    phone tens of milliseconds, better spent outside a frame) or painted now. Only call it from
    inside a custom layer's render(), where MapLibre expects texture state to change and restores
    its own afterwards. */
export function facadeTextures(gl: GL, pixels: readonly Pixels[] = paintFacades()): (WebGLTexture | null)[] {
  const anisotropic = gl.getExtension('EXT_texture_filter_anisotropic')
    ?? gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic') ?? gl.getExtension('MOZ_EXT_texture_filter_anisotropic')
  const most = anisotropic ? Number(gl.getParameter(anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) || 1 : 1
  gl.activeTexture(gl.TEXTURE0)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
  const textures = TEXTURE_NAMES.map((name, i) => {
    const texture = gl.createTexture()
    if (!texture) return null
    const { width, height, data } = pixels[i] ?? facadePixels(name)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    const wrap = name === 'door' || name === 'shadow' ? gl.CLAMP_TO_EDGE : gl.REPEAT
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap)
    if (anisotropic) gl.texParameterf(gl.TEXTURE_2D, anisotropic.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, most))
    return texture
  })
  gl.bindTexture(gl.TEXTURE_2D, null)
  return textures
}
