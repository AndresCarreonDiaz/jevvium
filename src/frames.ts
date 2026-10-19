import type { MaskRegion } from './screen.ts'

/**
 * A screenshot made ready to keep or to send: scaled down to the screen's size in points,
 * with the regions it is given painted over (see `maskRegions`), as a JPEG. `width` and
 * `height` are its size in pixels.
 */
export type PreparedFrame = { jpeg: Buffer; width: number; height: number }

/** The smallest side TypeSafe accepts for an image, in pixels. */
export const MIN_SIDE = 280
/** The largest side TypeSafe accepts for an image, in pixels. */
export const MAX_SIDE = 1568
/** The short side a frame gets when the screen's size in points isn't known (Android): about a phone's width in points. */
const DEFAULT_SHORT_SIDE = 400
const JPEG_QUALITY = 80
const MASK_FILL = '#8f8f8f'

/**
 * The size to scale a screenshot to: the screen's size in points when it is known (iOS, 402
 * x 874 on an iPhone 17), where a 3x screenshot has three times the detail a decision needs
 * and about nine times the tokens. Otherwise (Android, whose page source is in pixels) the
 * short side becomes 400 pixels. Either way each side stays within what TypeSafe accepts
 * (280 to 1568), keeping the aspect ratio.
 */
export function frameSize(pixels: { width: number; height: number }, points?: { width: number; height: number }): { width: number; height: number } {
  const short = Math.min(pixels.width, pixels.height)
  const target = points ? Math.min(points.width, points.height) : Math.min(DEFAULT_SHORT_SIDE, short)
  let scale = target / short
  if (Math.max(pixels.width, pixels.height) * scale > MAX_SIDE) scale = MAX_SIDE / Math.max(pixels.width, pixels.height)
  if (short * scale < MIN_SIDE) scale = MIN_SIDE / short
  const size = { width: Math.round(pixels.width * scale), height: Math.round(pixels.height * scale) }
  if (Math.max(size.width, size.height) > MAX_SIDE) {
    throw new Error(`A ${pixels.width} x ${pixels.height} screenshot is too narrow to fit TypeSafe's image limits (each side 280 to 1568 px)`)
  }
  return size
}

/**
 * Scales a screenshot (PNG or JPEG bytes) and paints over `regions`, given in the page
 * source's units: points on iOS, where `screen` is the screen's size in points, and the
 * screenshot's own pixels when `screen` is left out (Android). Each region is filled grey and
 * labelled with what it hides (`{email}`, `keyboard`), so a model looking at the frame
 * knows a field is filled without seeing its value.
 */
export async function prepareFrame(
  image: Buffer,
  options: { screen?: { width: number; height: number }; regions?: MaskRegion[] } = {},
): Promise<PreparedFrame> {
  const sharp = await loadSharp()
  const { width: pixelWidth, height: pixelHeight } = await sharp(image).metadata()
  if (!pixelWidth || !pixelHeight) throw new Error('The screenshot has no size')
  const size = frameSize({ width: pixelWidth, height: pixelHeight }, options.screen)
  // From the page source's units to the frame's pixels.
  const scale = size.width / (options.screen?.width ?? pixelWidth)
  const regions = options.regions ?? []
  let pipeline = sharp(image).resize(size.width, size.height, { fit: 'fill' })
  if (regions.length > 0) pipeline = pipeline.composite([{ input: Buffer.from(maskSvg(size, regions, scale)), top: 0, left: 0 }])
  const jpeg = await pipeline.jpeg({ quality: JPEG_QUALITY }).toBuffer()
  return { jpeg, width: size.width, height: size.height }
}

/** A plain grey frame of the smallest size TypeSafe accepts, for checking that a key and a model take images. */
export async function blankFrame(): Promise<PreparedFrame> {
  const sharp = await loadSharp()
  const jpeg = await sharp({ create: { width: MIN_SIDE, height: MIN_SIDE, channels: 3, background: MASK_FILL } }).jpeg().toBuffer()
  return { jpeg, width: MIN_SIDE, height: MIN_SIDE }
}

/** The masks as an SVG the size of the frame, to lay over it. */
export function maskSvg(size: { width: number; height: number }, regions: MaskRegion[], scale: number): string {
  const shapes = regions.map(({ frame, label }) => {
    const x = frame.x * scale
    const y = frame.y * scale
    const w = frame.w * scale
    const h = frame.h * scale
    const rect = `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${MASK_FILL}"/>`
    const fontSize = Math.min(14, h * 0.6)
    if (fontSize < 6) return rect
    // Helvetica's characters average a little over half the font size in width.
    const fits = Math.floor(w / (fontSize * 0.56))
    if (fits < 3) return rect
    const text = label.length > fits ? `${label.slice(0, fits - 1)}…` : label
    return (
      rect +
      `<text x="${(x + w / 2).toFixed(1)}" y="${(y + h / 2).toFixed(1)}" font-family="Helvetica, Arial, sans-serif" ` +
      `font-size="${fontSize.toFixed(1)}" fill="#ffffff" text-anchor="middle" dominant-baseline="central">${escapeXml(text)}</text>`
    )
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}">${shapes.join('')}</svg>`
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!)
}

type Sharp = (typeof import('sharp'))['default']
let sharpModule: Promise<Sharp> | undefined

/** sharp, loaded on first use: runs that take no screenshots never pay for loading it. */
function loadSharp(): Promise<Sharp> {
  sharpModule ??= import('sharp').then(
    (module): Sharp => module.default,
    (error: unknown) => {
      sharpModule = undefined
      throw new Error(
        `Screenshots need the sharp image library, an optional dependency that installs with jevvium on most systems (npm i -D sharp adds it): ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
        { cause: error },
      )
    },
  )
  return sharpModule!
}
