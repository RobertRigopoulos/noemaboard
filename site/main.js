/*
 * NoemaBoard front page. Tiny and optional: the page works without it.
 * No tracking, no cookies, no storage, no network requests.
 *
 * The source repository is set once, in <html data-repo="...">. While it is the REPO_OWNER
 * placeholder, links that need it stay hidden and the "coming soon" notes show instead.
 */
;(function () {
  var root = document.documentElement
  var repo = (root.getAttribute('data-repo') || '').trim().replace(/\/+$/, '')
  var hasRepo = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repo) && !/REPO_OWNER/.test(repo)

  function each(selector, fn) {
    Array.prototype.forEach.call(document.querySelectorAll(selector), fn)
  }

  if (hasRepo) {
    each('[data-repo-path]', function (a) {
      var path = a.getAttribute('data-repo-path')
      a.href = path ? repo + '/' + path : repo
      a.rel = 'noopener'
    })
    each('[data-repo-only]', function (el) {
      el.hidden = false
    })
    each('[data-repo-missing]', function (el) {
      el.hidden = true
    })

    // Outline the download that matches this computer (phones and tablets get no hint).
    var ua = navigator.userAgent || ''
    var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || ua
    var os = ''
    if (!/android|iphone|ipad|ipod|mobile/i.test(ua)) {
      if (/win/i.test(platform)) os = 'windows'
      else if (/mac/i.test(platform)) os = 'mac'
      else if (/linux|x11|cros/i.test(platform)) os = 'linux'
    }
    if (os) {
      var mine = document.querySelector('.dl[data-os="' + os + '"]')
      if (mine) mine.classList.add('is-yours')
    }
  }

  // A hairline under the sticky header once the page has scrolled.
  var ticking = false
  function onScroll() {
    if (ticking) return
    ticking = true
    requestAnimationFrame(function () {
      root.classList.toggle('is-scrolled', window.scrollY > 8)
      ticking = false
    })
  }
  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()

  // Screenshots that finished loading before this script ran (their inline onload handles the rest).
  each('.gallery__item img', function (img) {
    if (img.complete && img.naturalWidth > 0) {
      img.parentNode.hidden = false
      document.getElementById('look').hidden = false
    }
  })
})()
