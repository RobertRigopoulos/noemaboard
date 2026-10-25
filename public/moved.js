/*
 * NoemaBoard moved to https://noemaboard.app (October 2026). Pages at the old address send their
 * visitors there, keeping the path and the part after # (invite links carry their key there; it
 * never leaves the browser). People who already use NoemaBoard at the old address stay: browsers
 * keep boards separately for each address, and the app there shows them how to move theirs.
 *
 * Loaded first by the app (index.html) and the front page (site/index.html). Does nothing at any
 * other address. Only reads whether NoemaBoard was used here; stores and sends nothing.
 */
;(function (root) {
  var NEW_HOME = 'https://noemaboard.app'
  var OLD_HOSTS = ['app.noemaboard.workers.dev']

  /** True when this browser has a NoemaBoard profile or boards at this address. */
  function usedHere(getStorage) {
    var profile, library
    try {
      var storage = getStorage()
      profile = storage.getItem('noema:profile')
      library = storage.getItem('noema:library')
    } catch (e) {
      return false // storage is blocked, so nothing can have been saved here
    }
    try {
      var p = profile ? JSON.parse(profile) : null
      var l = library ? JSON.parse(library) : null
      var named = !!(p && typeof p.name === 'string' && p.name.trim())
      var boards = !!(l && typeof l === 'object' && Object.keys(l).length)
      return named || boards
    } catch (e) {
      return true // something is stored here, even if it can't be read: stay
    }
  }

  /** The address to send this page to, or null to stay. */
  function movedTarget(loc, getStorage) {
    if (OLD_HOSTS.indexOf(loc.hostname) < 0 || usedHere(getStorage)) return null
    return NEW_HOME + loc.pathname + loc.search + loc.hash
  }

  root.noemaMovedTarget = movedTarget
  if (typeof location === 'undefined') return
  var target = movedTarget(location, function () {
    return root.localStorage
  })
  if (!target) return
  // Stop this page first, so the old app never starts (stopping afterwards would cancel the move).
  try {
    root.stop()
  } catch (e) {
    // not supported: the page just keeps loading until the new one replaces it
  }
  location.replace(target)
})(typeof window !== 'undefined' ? window : this)
