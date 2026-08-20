import { build } from 'esbuild'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..')
const output = await build({
  entryPoints: [path.join(root, 'src', 'timelineGeometry.ts')],
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18',
})
const geometry = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)

let passed = 0
let failed = 0
const check = (ok, name, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ''}`) }
  else { failed++; console.error(`  FAIL  ${name}${detail ? ` (${detail})` : ''}`) }
}

const text = { start: 2, duration: 3, fadeIn: 0.5, fadeOut: 0.75 }
const layout = geometry.timelineBlockLayout(text, 40)

console.log('\n-- timeline block geometry --')
check(layout.left === 80, 'a block starts at its exact ruler time', `${layout.left}px`)
check(layout.width === 120, 'duration controls the complete block width', `${layout.width}px`)
check(layout.fadeInWidth === 20, 'fade-in occupies its proportional part of the block', `${layout.fadeInWidth}px`)
check(layout.fadeOutWidth === 30, 'fade-out occupies its proportional part of the block', `${layout.fadeOutWidth}px`)

console.log('\n-- fade timing contract --')
check(geometry.fadeFactor(text, 2) === 0, 'fade starts at the block start')
check(geometry.fadeFactor(text, 2.25) === 0.5, 'fade-in midpoint is half visible')
check(geometry.fadeFactor(text, 2.5) === 1, 'fade-in reaches full opacity on time')
check(geometry.fadeFactor(text, 4.625) === 0.5, 'fade-out midpoint is half visible')
check(geometry.fadeFactor(text, 5) === 0, 'fade ends at the block end')

const bounded = geometry.timelineBlockLayout({ start: 0, duration: 1, fadeIn: 4, fadeOut: -1 }, 10)
check(bounded.fadeInWidth === 10 && bounded.fadeOutWidth === 0, 'fade shading cannot extend outside its block')

console.log('\n-- timeline dragging --')
check(geometry.timelineDragStart(2, 40, 40, []) === 3, 'a 40px drag moves one second at the default zoom')
check(geometry.timelineDragStart(0.5, -80, 40, []) === 0, 'dragging before the timeline clamps to zero')
check(geometry.timelineDragStart(2, 37, 40, [3]) === 3, 'an edge within six pixels snaps to its target')
check(geometry.timelineDragStart(2, 33, 40, [3]) === 2.825, 'an edge outside six pixels remains unsnapped')

console.log('\n-- timeline resizing --')
const rightResize = geometry.timelineResize({ start: 2, duration: 3 }, 40, 40, 'right')
check(rightResize.start === 2 && rightResize.duration === 4, 'dragging the right edge changes only the duration')
const shortRightResize = geometry.timelineResize({ start: 2, duration: 1 }, -80, 40, 'right')
check(shortRightResize.duration === 0.3, 'the right edge cannot make a block shorter than 0.3s')
const leftResize = geometry.timelineResize({ start: 2, duration: 3 }, 40, 40, 'left')
check(leftResize.start === 3 && leftResize.duration === 2, 'dragging the left edge preserves the block end')
const longLeftResize = geometry.timelineResize({ start: 2, duration: 3 }, -160, 40, 'left')
check(longLeftResize.start === 0 && longLeftResize.duration === 5, 'the left edge can extend a block only as far as zero')

console.log('\n-- preview text resizing --')
check(geometry.textResizeFontSize(64, 40, 80) === 128, 'doubling the handle distance doubles the font size')
check(geometry.textResizeFontSize(64, 40, 1) === 8, 'preview resizing respects the minimum font size')
check(geometry.textResizeFontSize(300, 20, 60) === 400, 'preview resizing respects the maximum font size')
check(geometry.textResizeFontSize(64, 0, 80) === 64, 'a zero-distance resize start leaves the font stable')

console.log(`\n${failed ? '✗' : '✓'} ALL CHECKS ${failed ? 'FAILED' : 'PASSED'} - ${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
