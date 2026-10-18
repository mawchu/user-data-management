// 虛擬捲動三種 key 策略的效能比較：node bench/virtual-scroll/run.mjs
// id = 資料 id 當 key（v1）、slot = 直接用第幾格當 key（簡單版回收）、pool = 每格各自定位的回收（v2）
import { chromium } from 'playwright-core'

const pageUrl = new URL('./bench.html', import.meta.url).href
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM ??
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
})
const page = await browser.newPage()
await page.goto(pageUrl)
const cases = []
for (const kind of ['plain', 'component'])
  for (const [label, steps, stride] of [
    ['慢慢捲 1 列 × 10,000', 10000, 1],
    ['快速拖曳 37 列 × 500', 500, 37],
  ])
    for (const mode of ['id', 'slot', 'pool']) {
      const times = []
      for (let r = 0; r < 4; r++)
        times.push(
          await page.evaluate(
            ([m, k, s, st]) => window.run(m, k, s, st),
            [mode, kind, steps, stride],
          ),
        )
      times.sort((a, b) => a - b)
      const median = (times[1] + times[2]) / 2
      cases.push({
        列: kind === 'plain' ? '純 div' : '元件',
        情境: label,
        key: mode,
        '每步 ms（中位數）': +(median / steps).toFixed(3),
      })
    }
console.table(cases)
await browser.close()
