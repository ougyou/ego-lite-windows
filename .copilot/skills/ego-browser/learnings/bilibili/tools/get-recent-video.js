/**
 * Get the most recently published video of a Bilibili uploader.
 *
 * Encapsulates the hard-won flow from the 2026-08-16 case: the space page's
 * top banner / "首页" nav can point to a site-wide promoted video (e.g. the
 * official "22和33" 2233 birthday song), so we take ONLY the uploader's own
 * `.bili-video-card` cards — never the first `a[href*="/video/BV"]` on the page.
 *
 * @param {object} ctx - { browser, page, ... } facade context
 * @param {object} args - { uid, pageSize }
 * @returns {Promise<object>} { bvid, url, title, owner, pubdate }
 */
export async function getRecentVideo(ctx, args = {}) {
  const uid = String(args.uid || "").trim();
  if (!uid) throw new Error("uid is required");
  const pageSize = boundedInteger(args.pageSize, 20, 100);

  // Open the uploader's video tab (latest-first). Single-tab: navigate, don't
  // spawn extra tabs.
  await ctx.browser.openOrReuseTab(`https://space.bilibili.com/${uid}/video`, {
    wait: true,
    timeout: 30,
  });
  // `page` does not auto-attach to a freshly opened tab — poll until it does.
  for (let i = 0; i < 40; i++) {
    const u = await ctx.page.url();
    if (u.includes(`space.bilibili.com/${uid}`)) break;
    await ctx.page.waitForTimeout(500);
  }
  await ctx.page
    .waitForLoadState("networkidle", { timeout: 25000 })
    .catch(() => {});
  await ctx.page.waitForTimeout(2000);

  // Take only the uploader's own video cards. ES5 in the page context.
  const links = await ctx.page
    .locator(".bili-video-card a[href*='/video/BV']")
    .evaluateAll(function (as, limit) {
      const seen = {};
      const out = [];
      for (let i = 0; i < as.length; i++) {
        const href = as[i].getAttribute("href");
        if (!href || seen[href]) continue;
        seen[href] = true;
        out.push(href);
        if (out.length >= limit) break;
      }
      return out;
    }, pageSize);

  const first = links[0];
  if (!first) throw new Error("no uploader video cards found on the space page");

  const url = first.startsWith("//")
    ? "https:" + first
    : first.startsWith("/")
      ? "https://www.bilibili.com" + first
      : first;
  const bvid = (url.match(/BV[0-9A-Za-z]+/) || [""])[0];

  // Resolve title / owner / pubdate via the official view API (ES5 in page ctx).
  const info = await ctx.page.evaluate(function (bv) {
    return fetch("https://api.bilibili.com/x/web-interface/view?bvid=" + bv)
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        const d = j && j.data;
        return d
          ? {
              title: d.title,
              owner: d.owner ? d.owner.name : "",
              pubdate: d.pubdate,
              bvid: d.bvid,
            }
          : null;
      })
      .catch(function () {
        return null;
      });
  }, bvid);

  return { bvid, url, ...(info || {}) };
}

function boundedInteger(value, fallback, max) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(number)));
}
