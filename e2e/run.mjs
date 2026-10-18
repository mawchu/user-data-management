// 端對端驗證：node e2e/run.mjs（需先 npm run build && npm run preview）
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const BASE = process.env.BASE_URL ?? 'http://localhost:4173/'
const OUT = process.env.SHOTS ?? 'e2e/screenshots'
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM ??
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
})
const page = await browser.newPage({ viewport: { width: 1360, height: 820 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if (m.type() !== 'error') return
  errors.push(m.text())
  if (errors.length > 20) {
    console.error(errors.slice(0, 5).join('\n'))
    process.exit(1)
  }
})

import { writeSync } from 'node:fs'
const step = (name) => writeSync(1, `✓ ${name}\n`)
const rowsData = () =>
  page.$$eval('.body .row', (els) =>
    els.map((el) => {
      const c = [...el.querySelectorAll('.cell')].map((x) =>
        x.textContent.trim(),
      )
      return {
        num: c[0],
        id: Number(c[1]),
        userName: c[2],
        position: c[3],
        location: c[4],
        age: Number(c[5]),
        dateStart: c[6],
      }
    }),
  )
const total = async () =>
  Number((await page.textContent('[data-testid=total]')).replace(/,/g, ''))
const loaded = async () =>
  Number((await page.textContent('[data-testid=loaded]')).replace(/,/g, ''))
const waitIdle = () =>
  page.waitForFunction(
    () => !document.querySelector('.footer')?.textContent.includes('載入中'),
  )

const t0 = Date.now()
await page.goto(BASE)
await page.waitForSelector('.body .row', { timeout: 60_000 })
await waitIdle()
assert.equal(await total(), 10_000_000)
assert.equal(await loaded(), 500)
step(`初次載入：共 10,000,000 筆、先載入 500 筆（${Date.now() - t0}ms）`)
const domRows = (await rowsData()).length
assert.ok(domRows < 60, `DOM 只渲染 ${domRows} 列`)
step(`虛擬捲動：已載入 500 筆但 DOM 只有 ${domRows} 列`)
await page.screenshot({ path: `${OUT}/1-list.png` })

// 無限捲動
await page.$eval('.scroller', (el) => (el.scrollTop = el.scrollHeight))
await page.waitForFunction(
  () =>
    document
      .querySelector('[data-testid=loaded]')
      .textContent.replace(/,/g, '') === '1000',
)
await waitIdle()
const afterScroll = await rowsData()
assert.ok(afterScroll.length < 60)
const ids = new Set()
step('捲到底自動載入下一批：已載入 1,000 筆')
await page.$eval('.scroller', (el) => (el.scrollTop = 0))

// 排序
const sortBy = async (label) => {
  await page.click(`.sort:has-text("${label}")`)
  await waitIdle()
  await page.waitForTimeout(100)
}
await sortBy('Age')
let r = await rowsData()
assert.ok(
  r.every((x, i) => i === 0 || r[i - 1].age <= x.age) && r[0].age === 20,
  'age asc',
)
await sortBy('Age')
r = await rowsData()
assert.ok(
  r.every((x, i) => i === 0 || r[i - 1].age >= x.age) && r[0].age === 65,
  'age desc',
)
step(`Age 升冪首列 20 歲、降冪首列 ${r[0].age} 歲`)
await sortBy('Age') // 回到未排序
for (const [label, key] of [
  ['User name', 'userName'],
  ['Position', 'position'],
  ['Location', 'location'],
  ['Date Start', 'dateStart'],
]) {
  await sortBy(label)
  r = await rowsData()
  const sorted = r.every(
    (x, i) =>
      i === 0 ||
      r[i - 1][key].localeCompare(x[key], 'en', {
        sensitivity: 'base',
        numeric: true,
      }) <= 0,
  )
  assert.ok(sorted, `${key} asc`)
  await sortBy(label)
  r = await rowsData()
  assert.ok(
    r.every(
      (x, i) =>
        i === 0 ||
        r[i - 1][key].localeCompare(x[key], 'en', {
          sensitivity: 'base',
          numeric: true,
        }) >= 0,
    ),
    `${key} desc`,
  )
  await sortBy(label)
}
step('五個欄位都能升冪/降冪排序，畫面上的列順序正確')

// 搜尋
await page.fill('.search', 'chen')
await page.waitForFunction(
  () =>
    document.querySelector('[data-testid=total]').textContent !== '10,000,000',
)
await waitIdle()
r = await rowsData()
assert.ok(
  r.length > 0 &&
    r.every((x) =>
      [x.userName, x.position, x.location, String(x.age), x.dateStart].some(
        (v) => v.toLowerCase().includes('chen'),
      ),
    ),
)
step(
  `搜尋 "chen"：符合 ${(await total()).toLocaleString()} 筆，畫面上每列都含 chen`,
)
await page.fill('.search', '2015-03')
await page.waitForTimeout(500)
await waitIdle()
r = await rowsData()
assert.ok(r.every((x) => x.dateStart.startsWith('2015-03')))
step(
  `搜尋 "2015-03"：符合 ${(await total()).toLocaleString()} 筆，畫面上每列日期都是 2015-03`,
)
await page.screenshot({ path: `${OUT}/2-search.png` })
await page.fill('.search', '')
await page.waitForFunction(
  () =>
    document.querySelector('[data-testid=total]').textContent === '10,000,000',
)
await waitIdle()

// 取消過期請求：連續快速點表頭，前面的請求應該被取消
const abortedBefore = Number(await page.textContent('[data-testid=aborted]'))
await page.click('.sort:has-text("Location")')
await page.click('.sort:has-text("Location")')
await page.click('.sort:has-text("Location")')
await page.waitForTimeout(100)
await waitIdle()
const abortedAfter = Number(await page.textContent('[data-testid=aborted]'))
assert.ok(
  abortedAfter - abortedBefore >= 2,
  `aborted ${abortedBefore} -> ${abortedAfter}`,
)
r = await rowsData()
assert.deepEqual(
  r.slice(0, 5).map((x) => x.id),
  [1, 2, 3, 4, 5],
) // 取消排序後回到 id 順序
assert.equal(
  await page.getAttribute('.row.head [aria-sort="none"] >> nth=2', 'aria-sort'),
  'none',
)
step(
  `快速連點 Location 三次：取消了 ${abortedAfter - abortedBefore} 個過期請求，畫面停在最後一次（取消排序）的結果`,
)

// 釘選
r = await rowsData()
const target = r[12]
await page.click(`.row[data-id="${target.id}"] >> text=釘選`)
await page.fill('input[name=position]', '3')
await page.click('button:has-text("釘選")>>nth=-1')
await page.waitForSelector(`[role=status]:has-text("已把 #${target.id}")`)
await waitIdle()
r = await rowsData()
assert.equal(r[2].id, target.id)
assert.match(r[2].num, /📌/)
for (const label of ['Age', 'User name', 'Date Start']) {
  await sortBy(label)
  r = await rowsData()
  assert.equal(r[2].id, target.id, `sorted by ${label} asc`)
  await sortBy(label)
  r = await rowsData()
  assert.equal(r[2].id, target.id, `sorted by ${label} desc`)
  await page.screenshot({ path: `${OUT}/3-pinned.png` })
  await sortBy(label)
}
step(
  `把 #${target.id} 釘選在第 3 列，Age／User name／Date Start 升降冪排序後都還在第 3 列`,
)

// 同位置重複釘選
r = await rowsData()
const other = r[20]
await page.click(`.row[data-id="${other.id}"] >> text=釘選`)
await page.fill('input[name=position]', '3')
await page.click('button:has-text("釘選")>>nth=-1')
await page.waitForSelector('dialog [role=alert]')
assert.match(await page.textContent('dialog [role=alert]'), /已被/)
await page.click('dialog button:has-text("取消")')
step('同一位置已有釘選時，視窗顯示錯誤不會覆蓋')

// 更新
r = await rowsData()
const editRow = r[5]
await page.click(`.row[data-id="${editRow.id}"] >> text=編輯`)
await page.fill('input[name=age]', '30.5')
await page.click('button:has-text("下一步")')
assert.equal(await page.textContent('dialog small.error'), '請輸入整數')
await page.fill('input[name=age]', '99')
await page.fill('input[name=userName]', 'Mawchu Demo')
await page.click('button:has-text("下一步")')
await page.waitForSelector('dialog .diff')
await page.screenshot({ path: `${OUT}/4-confirm-update.png` })
const diffText = await page.textContent('dialog .diff')
assert.ok(diffText.includes('Mawchu Demo') && diffText.includes('99'))
// 先按取消：回到表單、資料沒改
await page.click('dialog button:has-text("取消")')
await page.waitForSelector('input[name=userName]')
assert.equal(await page.inputValue('input[name=userName]'), 'Mawchu Demo')
await page.click('button:has-text("下一步")')
await page.click('button:has-text("確定更新")')
await page.waitForSelector(`[role=status]:has-text("已更新 #${editRow.id}")`)
r = await rowsData()
const edited = r.find((x) => x.id === editRow.id)
assert.equal(edited.userName, 'Mawchu Demo')
assert.equal(edited.age, 99)
step(
  `更新 #${editRow.id}：小數年齡被擋下；確認視窗列出變更前後；確定後畫面顯示新值`,
)
await page.fill('.search', 'mawchu')
await page.waitForFunction(
  () => document.querySelector('[data-testid=total]').textContent === '1',
)
r = await rowsData()
assert.equal(r[0].id, editRow.id)
step('改過的資料可以被搜尋到（搜尋 "mawchu" 剛好 1 筆）')
await page.fill('.search', '')
await page.waitForFunction(
  () =>
    document.querySelector('[data-testid=total]').textContent === '10,000,000',
)
await waitIdle()

// 刪除
r = await rowsData()
const del = r[7]
await page.click(`.row[data-id="${del.id}"] >> text=刪除`)
await page.click('dialog button:has-text("取消")')
assert.ok((await page.$(`.row[data-id="${del.id}"]`)) !== null)
assert.equal(await total(), 10_000_000)
await page.click(`.row[data-id="${del.id}"] >> text=刪除`)
await page.screenshot({ path: `${OUT}/5-confirm-delete.png` })
await page.click('button:has-text("確定刪除")')
await page.waitForSelector(`[role=status]:has-text("已刪除 #${del.id}")`)
await page.waitForSelector(`.row[data-id="${del.id}"]`, { state: 'detached' })
assert.equal(await total(), 9_999_999)
step(`刪除 #${del.id}：按取消資料還在；按確定後消失，總數變 9,999,999`)

// 刪除後繼續捲動，不重複不漏
await page.$eval('.scroller', (el) => (el.scrollTop = el.scrollHeight))
await page.waitForFunction(
  () =>
    document
      .querySelector('[data-testid=loaded]')
      .textContent.replace(/,/g, '') === '999',
)
await waitIdle()
const allIds = await page.evaluate(async () => {
  const s = document.querySelector('.scroller')
  const seen = []
  // 只檢查已載入的 999 列（捲動途中會繼續預先載入，所以要設上限）
  for (let top = 0; top < 999 * 44; top += s.clientHeight) {
    s.scrollTop = top
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    )
    document
      .querySelectorAll('.body .row')
      .forEach((el) =>
        seen.push([
          Number(el.getAttribute('aria-rowindex')),
          Number(el.dataset.id),
        ]),
      )
  }
  return seen
})
const byIndex = new Map(allIds)
const uniq = new Set(byIndex.values())
assert.equal(byIndex.size, uniq.size, '沒有重複 id')
assert.ok(!uniq.has(del.id))
step(`刪除後再捲動載入：前 ${byIndex.size} 列 id 沒有重複，被刪的列沒有再出現`)

assert.deepEqual(errors, [], `console errors: ${errors.join('\n')}`)
step('瀏覽器 console 沒有錯誤')
await browser.close()
