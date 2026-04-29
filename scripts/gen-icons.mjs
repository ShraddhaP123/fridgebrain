// Run with: node scripts/gen-icons.mjs
// Generates public/icon-192.png and public/icon-512.png
import { createCanvas } from 'canvas'
import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function makeIcon(size) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  const r = size * 0.18 // corner radius

  // Background — green
  ctx.fillStyle = '#16a34a'
  ctx.beginPath()
  ctx.moveTo(r, 0)
  ctx.lineTo(size - r, 0)
  ctx.quadraticCurveTo(size, 0, size, r)
  ctx.lineTo(size, size - r)
  ctx.quadraticCurveTo(size, size, size - r, size)
  ctx.lineTo(r, size)
  ctx.quadraticCurveTo(0, size, 0, size - r)
  ctx.lineTo(0, r)
  ctx.quadraticCurveTo(0, 0, r, 0)
  ctx.closePath()
  ctx.fill()

  // Brain emoji centred
  ctx.font = `${size * 0.55}px serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('🧠', size / 2, size / 2)

  return canvas.toBuffer('image/png')
}

for (const size of [192, 512]) {
  const buf = makeIcon(size)
  const out = join(__dirname, '..', 'public', `icon-${size}.png`)
  writeFileSync(out, buf)
  console.log(`✓ icon-${size}.png`)
}
