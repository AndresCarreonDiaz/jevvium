import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import sharp from 'sharp'
import { blankFrame, frameSize, maskSvg, MAX_SIDE, MIN_SIDE, prepareFrame } from '../src/frames.ts'
import { redactor } from '../src/redact.ts'
import { maskRegions, parseScreen } from '../src/screen.ts'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.xml`, import.meta.url), 'utf8')
const inputs = { email: 'qa.demo@example.com', password: 'Str0ngPassw0rd' }

/** A plain white screenshot, the way a 3x iPhone takes it. */
const white = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer()

/** The colour of one pixel of a JPEG, as [r, g, b]. */
async function pixel(jpeg: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true })
  const at = (Math.round(y) * info.width + Math.round(x)) * info.channels
  return [data[at], data[at + 1], data[at + 2]]
}

describe('frameSize', () => {
  it('scales an iPhone screenshot down to the screen size in points', () => {
    assert.deepEqual(frameSize({ width: 1206, height: 2622 }, { width: 402, height: 874 }), { width: 402, height: 874 })
  })

  it('gives a screenshot of unknown density a short side of 400 pixels', () => {
    // Android bounds are pixels, so the page source's size says nothing about density.
    assert.deepEqual(frameSize({ width: 1080, height: 2400 }), { width: 400, height: 889 })
    // A screen the size of its points keeps them.
    assert.deepEqual(frameSize({ width: 402, height: 874 }, { width: 402, height: 874 }), { width: 402, height: 874 })
  })

  it('keeps every side within what TypeSafe accepts', () => {
    const small = frameSize({ width: 200, height: 400 })
    assert.equal(small.width, MIN_SIDE)
    assert.equal(small.height, 560)
    const tall = frameSize({ width: 2048, height: 8000 }, { width: 1024, height: 4000 })
    assert.equal(tall.height, MAX_SIDE)
    assert.ok(tall.width >= MIN_SIDE)
    assert.throws(() => frameSize({ width: 100, height: 4000 }), /too narrow/)
  })
})

describe('prepareFrame', () => {
  it('scales to points and paints the regions grey, in point coordinates', async () => {
    const frame = await prepareFrame(await white(1206, 2622), {
      screen: { width: 402, height: 874 },
      regions: [{ frame: { x: 69, y: 211, w: 303, h: 40 }, label: '{email}' }],
    })
    assert.equal(frame.width, 402)
    assert.equal(frame.height, 874)
    const [r, g, b] = await pixel(frame.jpeg, 80, 231)
    assert.ok(r < 170 && g < 170 && b < 170 && r > 110, `a masked pixel should be grey, got ${r},${g},${b}`)
    assert.deepEqual((await pixel(frame.jpeg, 200, 600)).map((c) => c > 245), [true, true, true])
    // A JPEG, which is what the request says it sends.
    assert.equal(frame.jpeg.subarray(0, 3).toString('hex'), 'ffd8ff')
  })

  it('masks a screenshot of the filled login form where the page source says, keyboard included', async () => {
    const source = fixture('ios-login-filled')
    const screen = parseScreen(source, 'ios')
    const frame = await prepareFrame(await white(1206, 2622), { screen: screen.size, regions: maskRegions(source, 'ios', redactor(inputs)) })
    const grey = async (x: number, y: number) => (await pixel(frame.jpeg, x, y)).every((c) => c < 190)
    assert.ok(await grey(80, 231), 'the typed email')
    assert.ok(await grey(80, 320), 'the typed password')
    assert.ok(await grey(200, 860), 'the keyboard')
    assert.ok(!(await grey(200, 150)), 'the title is left as it is')
  })

  it('makes a frame of the smallest size TypeSafe takes for checking a key', async () => {
    const frame = await blankFrame()
    assert.deepEqual([frame.width, frame.height], [MIN_SIDE, MIN_SIDE])
  })
})

describe('maskSvg', () => {
  it('labels each mask with what it hides, escaped, and leaves out text that would not fit', () => {
    const svg = maskSvg(
      { width: 402, height: 874 },
      [
        { frame: { x: 0, y: 0, w: 300, h: 40 }, label: 'Welcome <{full_name}> & co' },
        { frame: { x: 0, y: 100, w: 10, h: 4 }, label: '{email}' },
      ],
      1,
    )
    assert.match(svg, /Welcome &lt;\{full_name\}&gt; &amp; co/)
    assert.equal((svg.match(/<text/g) ?? []).length, 1)
    assert.equal((svg.match(/<rect/g) ?? []).length, 2)
  })
})
